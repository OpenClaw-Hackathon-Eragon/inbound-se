import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import { searchRepository } from "./nia";

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

export async function prepareResponse(query: string): Promise<PrepareResponseResult> {
  const finalMessage = await client().beta.messages.toolRunner({
    model: "claude-opus-4-7",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    tools: [niaSearchTool],
    messages: [{ role: "user", content: query }],
  });

  const text = finalMessage.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();

  return { text, stopReason: finalMessage.stop_reason };
}
