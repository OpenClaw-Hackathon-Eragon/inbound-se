import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { withTimeout } from "./llmTimeout";
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

If anything critical is missing, ask 1–3 targeted questions that a senior engineer would ask.

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
}): Promise<TriageResult | null> {
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
  return parseTriageJson(raw);
}

async function triageWithOpenAI(args: {
  thread: string;
  forceReady: boolean;
}): Promise<TriageResult | null> {
  const prompt = `${SYSTEM_PROMPT}\n\n${userPrompt({
    thread: args.thread,
    forceReady: args.forceReady,
  })}`;

  const res = await withTimeout({
    label: "OpenAI triage",
    timeoutMs: 20_000,
    run: (signal) =>
      openaiClient().chat.completions.create(
        {
          model: "gpt-5.5-medium",
          temperature: 0.2,
          messages: [{ role: "user", content: prompt }],
        },
        { signal },
      ),
  });

  const text = res.choices?.[0]?.message?.content?.trim() ?? "";
  return text ? parseTriageJson(text) : null;
}

export async function runTriage(args: {
  thread: string;
  round: 0 | 1;
}): Promise<TriageResult> {
  const forceReady = args.round >= 1;
  try {
    const parsedClaude = await triageWithClaude({
      thread: args.thread,
      forceReady,
    });
    if (parsedClaude) return parsedClaude;
  } catch {
    // fall through to OpenAI
  }

  try {
    const parsedOpenAI = await triageWithOpenAI({
      thread: args.thread,
      forceReady,
    });
    if (parsedOpenAI) return parsedOpenAI;
  } catch {
    // fall through to busy fallback
  }

  return busyTriageFallback(forceReady, args.thread);
}

