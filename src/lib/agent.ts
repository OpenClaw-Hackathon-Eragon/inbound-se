import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { searchRepository } from "./nia";
import { withTimeout } from "./llmTimeout";
import { openaiClient } from "./openaiClient";

const SUPABASE_JS_REPO = "supabase/supabase-js";

const SYSTEM_PROMPT = `You are a support agent for the supabase-js JavaScript client library.

You have a single tool, nia_search, that performs grounded search over an
indexed snapshot of the ${SUPABASE_JS_REPO} GitHub repository (source code,
docs, examples). Use it to look up real APIs, types, and usage patterns
before answering — do not rely on memory for specifics.

How to work:
- For any non-trivial question, call nia_search with a focused query first.
  Issue follow-up searches if the first results are incomplete.
- For trivial conversational turns ("hi", "thanks"), answer directly.
- Ground your answer in what nia_search returned. Keep code snippets short
  and copy-pastable. If the repo doesn't cover something, say so plainly
  rather than guessing.

Hard requirements (non-negotiable):
- Do NOT invent methods, options, imports, or file paths. If you are not sure,
  call nia_search again or say you can't confirm from the repo.
- Include 1–4 file path citations for any load-bearing claims, formatted like:
  [supabase-js/path/to/file.ts]
  Only cite paths that exist in the repo results you retrieved.
- Reply as an email:
  - Direct answer: 2–4 sentences.
  - Code example: one copy-pasteable block.
  - Short “Notes / gotchas” section if needed (bullets).

The reply will be sent back to the user as an email response, so write a
clean, self-contained answer — no meta-commentary about your tools.`;

function client(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return new Anthropic();
}

const niaSearchTool = betaZodTool({
  name: "nia_search",
  description:
    "Search the indexed supabase/supabase-js repository for code, docs, and examples relevant to a natural-language query. Returns Nia's raw search response as JSON.",
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        "Natural-language question or keywords to search the indexed repository for.",
      ),
  }),
  run: async ({ query }) => {
    const result = await searchRepository({
      query,
      repositories: [SUPABASE_JS_REPO],
    });
    return JSON.stringify(result);
  },
});

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

async function prepareResponseWithClaude(query: string): Promise<PrepareResponseResult> {
  const finalMessage = await withTimeout({
    label: "Claude answer",
    timeoutMs: 45_000,
    run: async (signal) => {
      const runner = client().beta.messages.toolRunner({
        model: "claude-opus-4-7",
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        tools: [niaSearchTool],
        messages: [{ role: "user", content: query }],
      });
      runner.setRequestOptions({ signal });
      return runner.runUntilDone();
    },
  });

  const text = finalMessage.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();

  return { text, stopReason: finalMessage.stop_reason };
}

async function prepareResponseWithOpenAI(query: string): Promise<PrepareResponseResult> {
  const retrieval = await withTimeout({
    label: "Nia search (OpenAI fallback)",
    timeoutMs: 20_000,
    run: async () =>
      searchRepository({
        query,
        repositories: [SUPABASE_JS_REPO],
      }),
  });

  const system = `${SYSTEM_PROMPT}

You do NOT have access to tools in this mode. You are given retrieved repo context below; do not invent anything beyond it.`;

  const user = [
    `DEVELOPER_THREAD_AND_CONTEXT:`,
    query,
    ``,
    `RETRIEVED_REPO_CONTEXT_JSON:`,
    JSON.stringify(retrieval).slice(0, 60_000),
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
  if (!text) {
    throw new Error("OpenAI returned empty response");
  }
  return { text, stopReason: "openai_fallback" };
}

export async function prepareResponse(query: string): Promise<PrepareResponseResult> {
  try {
    const res = await prepareResponseWithClaude(query);
    if (res.text.trim()) return res;
    throw new Error("Claude returned empty response");
  } catch {
    // fall through
  }

  try {
    const res = await prepareResponseWithOpenAI(query);
    if (res.text.trim()) return res;
    throw new Error("OpenAI returned empty response");
  } catch {
    // fall through
  }

  return { text: BUSY_FALLBACK_TEXT, stopReason: "busy_fallback" };
}
