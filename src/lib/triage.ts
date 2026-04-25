import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { withTimeout } from "./llmTimeout";
import { log, serializeError, summarizeText, type LogCtx } from "./log";
import { openaiClient } from "./openaiClient";

export const TriageResultSchema = z.union([
  z.object({
    status: z.literal("NEED_INFO"),
    questions: z.array(z.string().min(1)).min(1).max(3),
  }),
  z.object({
    status: z.literal("READY"),
    query: z.object({
      question: z.string().min(1),
      feature_area: z.string().min(1).optional(),
      framework: z.string().min(1).optional(),
      goal: z.string().min(1).optional(),
      what_they_tried: z.string().min(1).optional(),
      errors: z.string().min(1).optional(),
      versions: z.string().min(1).optional(),
      context: z.string().min(1).optional(),
    }),
  }),
]);

export type TriageResult = z.infer<typeof TriageResultSchema>;

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return new Anthropic();
}

const SYSTEM_PROMPT = `You are the triage layer for a developer support agent that answers questions about supabase-js.

Your job: read the email thread and decide if there is enough specific information to answer with a grounded, code-citation-based reply.

A useful answer requires at minimum:
- The specific feature/area (auth, realtime, storage, db queries, edge functions, etc.)
- The framework/environment (Next.js App Router, React SPA, Node script, React Native, etc.)
- The developer's concrete goal + what is failing (error message or observed behavior)

If anything critical is missing, ask 1-3 targeted questions that a senior engineer would ask.

Output MUST be valid JSON matching one of:
{ "status": "NEED_INFO", "questions": ["...", "..."] }
{ "status": "READY", "query": { "question": "...", "framework": "...", "feature_area": "...", "goal": "...", "what_they_tried": "...", "errors": "...", "versions": "...", "context": "..." } }

Do not include any keys besides those allowed. Do not include markdown fences.`;

function userPrompt(args: { thread: string; forceReady: boolean }): string {
  const force = args.forceReady
    ? `\n\nImportant: This is the second turn. You MUST output status READY even if some fields are unknown. Fill unknowns with best-effort from the thread and omit optional fields you can't infer.`
    : "";
  return `THREAD:\n${args.thread.trim()}\n${force}`;
}

function extractTextBlock(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function parseTriageJson(raw: string): TriageResult | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const res = TriageResultSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

function busyTriageFallback(forceReady: boolean, thread: string): TriageResult {
  if (forceReady) {
    return {
      status: "READY",
      query: {
        question: "Help with a supabase-js integration issue (details in thread).",
        context: thread.slice(0, 5000),
      },
    };
  }
  return {
    status: "NEED_INFO",
    questions: [
      "Which framework/environment are you using (Next.js App Router, React SPA, Node script, React Native, etc.)?",
      "Which supabase-js feature area is this (auth, database queries, realtime, storage)?",
      "What exactly is failing (error message or observed behavior) and what have you tried so far?",
    ],
  };
}

async function triageWithClaude(args: {
  thread: string;
  forceReady: boolean;
  ctx?: LogCtx;
}): Promise<TriageResult | null> {
  const ctx = args.ctx ?? {};
  const start = Date.now();
  const message = await withTimeout({
    label: "Claude triage",
    timeoutMs: 20_000,
    run: (signal) =>
      client().messages.create(
        {
          model: "claude-opus-4-7",
          max_tokens: 1200,
          temperature: 0.2,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: userPrompt({
                thread: args.thread,
                forceReady: args.forceReady,
              }),
            },
          ],
        },
        { signal },
      ),
  });

  const raw = extractTextBlock(message);
  log(
    "info",
    "triage.claude.response",
    {
      model: "claude-opus-4-7",
      durationMs: Date.now() - start,
      stopReason: (message as unknown as { stop_reason?: unknown }).stop_reason ?? null,
      text: summarizeText(raw),
      contentBlocks: message.content?.map((b) => b.type) ?? [],
      usage: (message as unknown as { usage?: unknown }).usage ?? undefined,
    },
    { ...ctx, component: "triage" },
  );
  return parseTriageJson(raw);
}

async function triageWithOpenAI(args: {
  thread: string;
  forceReady: boolean;
  ctx?: LogCtx;
}): Promise<TriageResult | null> {
  const ctx = args.ctx ?? {};
  const prompt = `${SYSTEM_PROMPT}\n\n${userPrompt({
    thread: args.thread,
    forceReady: args.forceReady,
  })}`;

  const start = Date.now();
  const res = await withTimeout({
    label: "OpenAI triage",
    timeoutMs: 20_000,
    run: (signal) =>
      openaiClient().chat.completions.create(
        {
          model: "gpt-5.5-medium",
          messages: [{ role: "user", content: prompt }],
        },
        { signal },
      ),
  });

  const text = res.choices?.[0]?.message?.content?.trim() ?? "";
  log(
    "info",
    "triage.openai.response",
    {
      model: res.model ?? "gpt-5.5-medium",
      responseId: (res as unknown as { id?: unknown }).id ?? undefined,
      durationMs: Date.now() - start,
      finishReason: res.choices?.[0]?.finish_reason ?? null,
      text: summarizeText(text),
      usage: (res as unknown as { usage?: unknown }).usage ?? undefined,
    },
    { ...ctx, component: "triage" },
  );
  return text ? parseTriageJson(text) : null;
}

export async function runTriage(args: {
  thread: string;
  round: 0 | 1;
  ctx?: LogCtx;
}): Promise<TriageResult> {
  const forceReady = args.round >= 1;
  const ctx = args.ctx ?? {};
  log(
    "info",
    "triage.start",
    { round: args.round, forceReady, threadLen: args.thread.length },
    { ...ctx, component: "triage" },
  );
  try {
    const parsedClaude = await triageWithClaude({
      thread: args.thread,
      forceReady,
      ctx,
    });
    if (parsedClaude) return parsedClaude;
    log(
      "warn",
      "triage.claude.unparseable",
      { note: "Claude returned text but JSON schema parse failed" },
      { ...ctx, component: "triage" },
    );
  } catch (err) {
    log(
      "error",
      "triage.claude.error",
      { error: serializeError(err) },
      { ...ctx, component: "triage" },
    );
  }

  try {
    const parsedOpenAI = await triageWithOpenAI({
      thread: args.thread,
      forceReady,
      ctx,
    });
    if (parsedOpenAI) return parsedOpenAI;
    log(
      "warn",
      "triage.openai.unparseable_or_empty",
      { note: "OpenAI returned empty or JSON parse failed" },
      { ...ctx, component: "triage" },
    );
  } catch (err) {
    log(
      "error",
      "triage.openai.error",
      { error: serializeError(err) },
      { ...ctx, component: "triage" },
    );
  }

  log(
    "warn",
    "triage.fallback",
    { forceReady, result: forceReady ? "READY" : "NEED_INFO" },
    { ...ctx, component: "triage" },
  );
  return busyTriageFallback(forceReady, args.thread);
}

