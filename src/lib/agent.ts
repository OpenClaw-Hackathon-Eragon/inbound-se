import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { searchSources } from "./nia";
import { withTimeout } from "./llmTimeout";
import { log, serializeError, summarizeText, withSpan, type LogCtx } from "./log";
import { openaiClient } from "./openaiClient";

const SUPABASE_JS_REPO = "supabase/supabase-js";
const SUPABASE_DOCS_URL = "https://supabase.com/docs/reference/javascript/start";

const MODEL_SUBAGENT_EASY = "claude-sonnet-4-6";
const MODEL_SUBAGENT_HARD = "claude-opus-4-7";
const MODEL_MASTER = "claude-haiku-4-5-20251001";
const MODEL_CLASSIFIER = "claude-haiku-4-5-20251001";

type Difficulty = "easy" | "complex";

const CLASSIFIER_PROMPT = `You triage incoming developer-support questions for a supabase-js support agent.
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

const REPO_SUBAGENT_PROMPT = `You are a research subagent. Your only job is to surface relevant facts
from the indexed ${SUPABASE_JS_REPO} GitHub repository (source code, types, examples).

You have one tool, nia_search_repo. Use it.

How to work:
- Run 1-3 focused queries. Issue follow-ups if the first results are thin.
- Pull out concrete API names, type signatures, options, file paths, and short snippets.
- Cite file paths exactly as they appear in Nia's results, formatted as
  [supabase-js/path/to/file.ts]. Only cite paths you actually retrieved.
- Do NOT invent anything. If something isn't in the results, say so.

Output format (plain text, no preamble, no email niceties):
- "Findings:" then 3-8 bullets of factual takeaways, each with a citation.
- "Code:" then one short copy-pasteable snippet if relevant.
- "Gaps:" 0-2 bullets describing what the repo did NOT cover for this question.

You are not writing the final reply. A separate agent will compile findings from
you and a docs subagent into a single response.`;

const DOCS_SUBAGENT_PROMPT = `You are a research subagent. Your only job is to surface relevant guidance
from the indexed Supabase JS reference documentation (root: ${SUPABASE_DOCS_URL}).

You have one tool, nia_search_docs. Use it.

How to work:
- Run 1-3 focused queries. Issue follow-ups if the first results are thin.
- Pull out concrete how-to guidance, recommended patterns, configuration knobs,
  and short example snippets.
- Cite source paths/URLs exactly as Nia returns them, formatted as
  [supabase-docs/<path-or-url>]. Only cite paths you actually retrieved.
- Do NOT invent anything. If something isn't in the results, say so.

Output format (plain text, no preamble, no email niceties):
- "Findings:" then 3-8 bullets of factual takeaways, each with a citation.
- "Code:" then one short copy-pasteable snippet if the docs provide one.
- "Gaps:" 0-2 bullets describing what the docs did NOT cover for this question.

You are not writing the final reply. A separate agent will compile findings from
you and a repo subagent into a single response.`;

const MASTER_PROMPT = `You are a support agent for the supabase-js JavaScript client library.
Two research subagents have already searched authoritative sources for you:

1. REPO_FINDINGS: from the ${SUPABASE_JS_REPO} GitHub repository.
2. DOCS_FINDINGS: from the official Supabase JS reference docs.

Compile a single email reply that draws on BOTH sources:
- Prefer DOCS for "how to use this in practice" guidance.
- Prefer REPO for exact exports, type signatures, and edge-case behavior.
- If they conflict, trust the repo (source of truth) and note the discrepancy briefly.
- If one of the findings sets is marked unavailable, work from whatever you have.

Hard requirements (non-negotiable):
- Do NOT invent methods, options, imports, or paths beyond what the subagents reported.
  If neither source covers something, say so plainly.
- Cite paths/URLs exactly as the subagents listed them. Mix citations from both
  sources where it strengthens the answer. 1-4 citations total.
- Reply as an email:
  - Direct answer: 2-4 sentences.
  - Code example: one copy-pasteable block.
  - Short "Notes / gotchas" section if needed (bullets).

The reply will be sent back to the user as an email response. Write a clean,
self-contained answer — no meta-commentary about your tools or the subagent process.`;

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

const repoSearchTool = (ctx: LogCtx) =>
  betaZodTool({
    name: "nia_search_repo",
    description: `Search the indexed ${SUPABASE_JS_REPO} GitHub repository for code, types, and examples relevant to a natural-language query. Returns Nia's raw search response as JSON.`,
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe("Natural-language question or keywords to search the indexed repo for."),
    }),
    run: async ({ query }) => {
      const result = await searchSources({
        query,
        repositories: [SUPABASE_JS_REPO],
        ctx: { ...ctx, component: "agent.repo" },
      });
      return JSON.stringify(result);
    },
  });

const docsSearchTool = (ctx: LogCtx) =>
  betaZodTool({
    name: "nia_search_docs",
    description: `Search the indexed Supabase JS reference docs (${SUPABASE_DOCS_URL}) for guidance and examples relevant to a natural-language query. Returns Nia's raw search response as JSON.`,
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe("Natural-language question or keywords to search the indexed docs for."),
    }),
    run: async ({ query }) => {
      const result = await searchSources({
        query,
        dataSources: [SUPABASE_DOCS_URL],
        ctx: { ...ctx, component: "agent.docs" },
      });
      return JSON.stringify(result);
    },
  });

async function classifyDifficulty(query: string, ctx: LogCtx): Promise<Difficulty> {
  try {
    const res = await withTimeout({
      label: "Difficulty classifier",
      timeoutMs: 5_000,
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
  tool: ReturnType<typeof repoSearchTool>;
  query: string;
  model: string;
  ctx: LogCtx;
}): Promise<string> {
  const message = await withTimeout({
    label: args.label,
    timeoutMs: 35_000,
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

async function synthesize(args: {
  query: string;
  repoFindings: string | null;
  docsFindings: string | null;
  ctx: LogCtx;
}): Promise<string> {
  const userMessage = [
    `USER_QUESTION:`,
    args.query,
    ``,
    `REPO_SUBAGENT_FINDINGS:`,
    args.repoFindings ?? "(unavailable — repo subagent failed or returned nothing)",
    ``,
    `DOCS_SUBAGENT_FINDINGS:`,
    args.docsFindings ?? "(unavailable — docs subagent failed or returned nothing)",
  ].join("\n");

  const res = await withTimeout({
    label: "Master synthesize",
    timeoutMs: 20_000,
    run: (signal) =>
      client().beta.messages.create(
        {
          model: MODEL_MASTER,
          max_tokens: 2000,
          system: MASTER_PROMPT,
          messages: [{ role: "user", content: userMessage }],
        },
        { signal },
      ),
  });

  const text = extractText(res);
  log(
    "info",
    "agent.master.response",
    {
      model: MODEL_MASTER,
      stopReason: res.stop_reason ?? null,
      text: summarizeText(text),
      usage: (res as unknown as { usage?: unknown }).usage ?? undefined,
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

— Inbound (supabase-js support)`;

async function prepareResponseWithClaude(
  query: string,
  ctx: LogCtx,
): Promise<PrepareResponseResult> {
  const difficulty = await withSpan(
    "agent.classify",
    () => classifyDifficulty(query, ctx),
    ctx,
  );
  const subagentModel =
    difficulty === "easy" ? MODEL_SUBAGENT_EASY : MODEL_SUBAGENT_HARD;

  const [repoResult, docsResult] = await Promise.allSettled([
    withSpan(
      "agent.subagent.repo",
      () =>
        runSubagent({
          label: "Repo subagent",
          systemPrompt: REPO_SUBAGENT_PROMPT,
          tool: repoSearchTool(ctx),
          query,
          model: subagentModel,
          ctx,
        }),
      ctx,
      { difficulty, model: subagentModel },
    ),
    withSpan(
      "agent.subagent.docs",
      () =>
        runSubagent({
          label: "Docs subagent",
          systemPrompt: DOCS_SUBAGENT_PROMPT,
          tool: docsSearchTool(ctx),
          query,
          model: subagentModel,
          ctx,
        }),
      ctx,
      { difficulty, model: subagentModel },
    ),
  ]);

  const repoFindings =
    repoResult.status === "fulfilled" && repoResult.value.trim()
      ? repoResult.value
      : null;
  const docsFindings =
    docsResult.status === "fulfilled" && docsResult.value.trim()
      ? docsResult.value
      : null;

  if (repoResult.status === "rejected") {
    log(
      "warn",
      "agent.subagent.repo.failed",
      { error: serializeError(repoResult.reason) },
      { ...ctx, component: "agent" },
    );
  }
  if (docsResult.status === "rejected") {
    log(
      "warn",
      "agent.subagent.docs.failed",
      { error: serializeError(docsResult.reason) },
      { ...ctx, component: "agent" },
    );
  }

  if (!repoFindings && !docsFindings) {
    throw new Error("Both subagents failed or returned empty");
  }

  const text = await withSpan(
    "agent.master",
    () => synthesize({ query, repoFindings, docsFindings, ctx }),
    ctx,
  );

  log(
    "info",
    "agent.claude.response",
    {
      mode: "multi_agent",
      difficulty,
      subagentModel,
      masterModel: MODEL_MASTER,
      repoOk: !!repoFindings,
      docsOk: !!docsFindings,
      text: summarizeText(text),
    },
    { ...ctx, component: "agent" },
  );

  return { text, stopReason: `claude_multi_agent:${difficulty}` };
}

async function prepareResponseWithOpenAI(
  query: string,
  ctx: LogCtx,
): Promise<PrepareResponseResult> {
  const [repoResult, docsResult] = await Promise.allSettled([
    withTimeout({
      label: "Nia repo search (OpenAI fallback)",
      timeoutMs: 20_000,
      run: async () =>
        searchSources({
          query,
          repositories: [SUPABASE_JS_REPO],
          ctx: { ...ctx, component: "agent.repo" },
        }),
    }),
    withTimeout({
      label: "Nia docs search (OpenAI fallback)",
      timeoutMs: 20_000,
      run: async () =>
        searchSources({
          query,
          dataSources: [SUPABASE_DOCS_URL],
          ctx: { ...ctx, component: "agent.docs" },
        }),
    }),
  ]);

  const repoCtx =
    repoResult.status === "fulfilled"
      ? JSON.stringify(repoResult.value).slice(0, 30_000)
      : "(unavailable)";
  const docsCtx =
    docsResult.status === "fulfilled"
      ? JSON.stringify(docsResult.value).slice(0, 30_000)
      : "(unavailable)";

  if (repoResult.status === "rejected" && docsResult.status === "rejected") {
    throw new Error("Both Nia searches failed in OpenAI fallback");
  }

  const system = `${MASTER_PROMPT}

You do NOT have access to tools in this mode. You are given retrieved repo and docs context below; do not invent anything beyond it.`;

  const user = [
    `USER_QUESTION:`,
    query,
    ``,
    `RETRIEVED_REPO_CONTEXT_JSON:`,
    repoCtx,
    ``,
    `RETRIEVED_DOCS_CONTEXT_JSON:`,
    docsCtx,
  ].join("\n");

  const res = await withTimeout({
    label: "OpenAI answer",
    timeoutMs: 45_000,
    run: (signal) =>
      openaiClient().chat.completions.create(
        {
          model: "gpt-5.5-medium",
          temperature: 0.2,
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
      repoOk: repoResult.status === "fulfilled",
      docsOk: docsResult.status === "fulfilled",
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
