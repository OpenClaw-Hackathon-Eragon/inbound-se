import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { searchSources } from "./nia";
import { withTimeout } from "./llmTimeout";
import { log, serializeError, summarizeText, withSpan, type LogCtx } from "./log";
import { openaiClient } from "./openaiClient";
import { TEN_MINUTES_MS } from "./timeouts";

const MODEL_SUBAGENT_EASY = "claude-sonnet-4-6";
const MODEL_SUBAGENT_HARD = "claude-opus-4-7";
const MODEL_CLASSIFIER = "claude-haiku-4-5-20251001";

type Difficulty = "easy" | "complex";

const CLASSIFIER_PROMPT = `You triage incoming developer-support questions for a developer support agent.
Pick which model tier should answer.

Output exactly one lowercase word: easy OR complex. No punctuation, no explanation.

EASY — a smaller model can handle it:
- A single conceptual question with no error context.
- "How do I X?" / "What does Y return?" / "Difference between A and B?"
- Greetings, one-line clarifications, definitional lookups.

COMPLEX — needs the strongest model:
- Multi-part questions, or a question plus a stack trace / failing code / config.
- Debugging across multiple files, frameworks, or runtime behaviors.
- Anything that requires reconciling conflicting signals or non-obvious reasoning.

When unsure, choose complex.`;

const COMBINED_PROMPT = `You are a support agent that first researches a question using the knowledge base, then writes a clean email response.

## Phase 1 — Research

Use the nia_search_kb tool to find relevant facts before writing anything.

- Run 1-3 focused queries. Issue follow-ups if the first results are thin.
- Pull out concrete API names, type signatures, options, file paths, and short snippets.
- Only use information you actually retrieved. Do NOT invent anything.

## Phase 2 — Email Response

Using only what you found above, write the final email reply.

Hard requirements (non-negotiable):
- Do NOT invent methods, options, imports, or paths beyond what the KB returned.
  If the KB did not cover something, say so plainly.
- Cite source paths/URLs exactly as Nia returned them, formatted as [kb/<path-or-url>].
  1-4 citations total, only citing paths you actually retrieved.
- Structure the reply as:
  - Direct answer: 2-4 sentences.
  - Code example: one copy-pasteable block (if relevant).
  - Short "Notes / gotchas" section if needed (bullets).

Write a clean, self-contained answer — no meta-commentary about your tools or research process.`;

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return new Anthropic();
}

function extractText(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

const kbSearchTool = (ctx: LogCtx) =>
  betaZodTool({
    name: "nia_search_kb",
    description: `Search the indexed knowledge base in Nia. Returns Nia's raw search response as JSON.`,
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe("Natural-language question or keywords to search the knowledge base for."),
    }),
    run: async ({ query }) => {
      const result = await searchSources({
        query,
        // No per-repo config: this assumes the user's Nia account is already
        // set up so that searching without explicit scoping hits the intended KB.
        // If this isn't true, `searchSources` should be extended to support a
        // single configured KB scope from Nia itself (not from this app).
        dataSources: [],
        ctx: { ...ctx, component: "agent.kb" },
      });
      return JSON.stringify(result);
    },
  });

async function classifyDifficulty(query: string, ctx: LogCtx): Promise<Difficulty> {
  try {
    const res = await withTimeout({
      label: "Difficulty classifier",
      timeoutMs: TEN_MINUTES_MS,
      run: (signal) =>
        client().messages.create(
          {
            model: MODEL_CLASSIFIER,
            max_tokens: 8,
            system: CLASSIFIER_PROMPT,
            messages: [{ role: "user", content: query }],
          },
          { signal },
        ),
    });
    const raw = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .toLowerCase();
    const difficulty: Difficulty = raw.startsWith("easy") ? "easy" : "complex";
    log(
      "info",
      "agent.classify.ok",
      { difficulty, raw, model: MODEL_CLASSIFIER },
      { ...ctx, component: "agent" },
    );
    return difficulty;
  } catch (err) {
    log(
      "warn",
      "agent.classify.failed",
      { error: serializeError(err) },
      { ...ctx, component: "agent" },
    );
    return "complex";
  }
}

async function runSubagent(args: {
  label: string;
  systemPrompt: string;
  tool: ReturnType<typeof kbSearchTool>;
  query: string;
  model: string;
  ctx: LogCtx;
}): Promise<string> {
  const message = await withTimeout({
    label: args.label,
    timeoutMs: TEN_MINUTES_MS,
    run: async (signal) => {
      const runner = client().beta.messages.toolRunner({
        model: args.model,
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        system: args.systemPrompt,
        tools: [args.tool],
        messages: [{ role: "user", content: args.query }],
      });
      runner.setRequestOptions({ signal });
      return runner.runUntilDone();
    },
  });

  const text = extractText(message);
  log(
    "info",
    "agent.subagent.response",
    {
      label: args.label,
      model: args.model,
      stopReason: message.stop_reason ?? null,
      contentBlocks: message.content?.map((b) => b.type) ?? [],
      text: summarizeText(text),
      usage: (message as unknown as { usage?: unknown }).usage ?? undefined,
    },
    { ...args.ctx, component: "agent" },
  );
  return text;
}

export type PrepareResponseResult = {
  text: string;
  stopReason: string | null;
};

const BUSY_FALLBACK_TEXT = `Thanks for reaching out — our support agents are busy right now.

Please try again in a few minutes. If it’s urgent, feel free to reply with:
- your framework (Next.js/React/Node/etc.)
- the exact error message
- what you’ve tried so far

— Inbound (support)`;

async function prepareResponseWithClaude(
  query: string,
  ctx: LogCtx,
): Promise<PrepareResponseResult> {
  const difficulty = await withSpan(
    "agent.classify",
    () => classifyDifficulty(query, ctx),
    ctx,
  );
  const model = difficulty === "easy" ? MODEL_SUBAGENT_EASY : MODEL_SUBAGENT_HARD;

  const text = await withSpan(
    "agent.combined",
    () =>
      runSubagent({
        label: "Combined KB research + email",
        systemPrompt: COMBINED_PROMPT,
        tool: kbSearchTool(ctx),
        query,
        model,
        ctx,
      }),
    ctx,
    { difficulty, model },
  );

  log(
    "info",
    "agent.claude.response",
    {
      mode: "combined",
      difficulty,
      model,
      text: summarizeText(text),
    },
    { ...ctx, component: "agent" },
  );

  return { text, stopReason: `claude_combined:${difficulty}` };
}

async function prepareResponseWithOpenAI(
  query: string,
  ctx: LogCtx,
): Promise<PrepareResponseResult> {
  const kbResult = await withTimeout({
    label: "Nia KB search (OpenAI fallback)",
    timeoutMs: TEN_MINUTES_MS,
    run: (signal) =>
      searchSources({
        query,
        dataSources: [],
        ctx: { ...ctx, component: "agent.kb" },
        signal,
      }),
  });
  const kbCtx = JSON.stringify(kbResult).slice(0, 60_000);

  const system = `You are a support agent writing an email response using only retrieved knowledge base context.

Hard requirements (non-negotiable):
- Do NOT invent methods, options, imports, or paths beyond what the retrieved KB context contains.
  If the KB did not cover something, say so plainly.
- Cite source paths/URLs exactly as they appear in the retrieved KB context, formatted as [kb/<path-or-url>].
  1-4 citations total, only citing sources present in the retrieved context.
- Structure the reply as:
  - Direct answer: 2-4 sentences.
  - Code example: one copy-pasteable block (if relevant).
  - Short "Notes / gotchas" section if needed (bullets).

Write a clean, self-contained answer — no meta-commentary.`;

  const user = [
    `USER_QUESTION:`,
    query,
    ``,
    `RETRIEVED_KB_CONTEXT_JSON:`,
    kbCtx,
  ].join("\n");

  const res = await withTimeout({
    label: "OpenAI answer",
    timeoutMs: TEN_MINUTES_MS,
    run: (signal) =>
      openaiClient().chat.completions.create(
        {
          model: "gpt-5.5-medium",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        { signal },
      ),
  });

  const text = res.choices?.[0]?.message?.content?.trim() ?? "";
  log(
    "info",
    "agent.openai.response",
    {
      model: res.model ?? "gpt-5.5-medium",
      responseId: (res as unknown as { id?: unknown }).id ?? undefined,
      finishReason: res.choices?.[0]?.finish_reason ?? null,
      kbOk: true,
      text: summarizeText(text),
      usage: (res as unknown as { usage?: unknown }).usage ?? undefined,
    },
    { ...ctx, component: "agent" },
  );
  if (!text) {
    throw new Error("OpenAI returned empty response");
  }
  return { text, stopReason: "openai_fallback" };
}

export async function prepareResponse(
  query: string,
  ctx: LogCtx = {},
): Promise<PrepareResponseResult> {
  const effectiveCtx = { ...ctx, component: "agent" };
  log(
    "info",
    "agent.prepare.start",
    { queryLen: query.length, queryPreview: query.slice(0, 300) },
    effectiveCtx,
  );
  try {
    const res = await withSpan(
      "agent.claude",
      () => prepareResponseWithClaude(query, effectiveCtx),
      effectiveCtx,
    );
    if (res.text.trim()) return res;
    throw new Error("Claude returned empty response");
  } catch (err) {
    log(
      "error",
      "agent.claude.error",
      { error: serializeError(err) },
      effectiveCtx,
    );
  }

  try {
    const res = await withSpan(
      "agent.openai",
      () => prepareResponseWithOpenAI(query, effectiveCtx),
      effectiveCtx,
    );
    if (res.text.trim()) return res;
    throw new Error("OpenAI returned empty response");
  } catch (err) {
    log(
      "error",
      "agent.openai.error",
      { error: serializeError(err) },
      effectiveCtx,
    );
  }

  log("warn", "agent.busy_fallback", {}, effectiveCtx);
  return { text: BUSY_FALLBACK_TEXT, stopReason: "busy_fallback" };
}
