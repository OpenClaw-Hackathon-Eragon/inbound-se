# inbound — Hackathon scaffold (AgentMail webhook → Next.js)

This repo is a minimal Next.js app deployed on Vercel and used as the webhook receiver for AgentMail.

It implements an **email-based support agent for `supabase-js`**:

- Inbound email → LLM triage
- If underspecified → 1 clarifying email (hard cap)
- If ready → grounded answer with code + citations, via parallel Nia retrievals over the `supabase/supabase-js` repo **and** the Supabase JS reference docs, compiled by a master agent

## Agent pipeline

Each ready-to-answer query flows through 4 stages. Models are picked per-stage to trade cost for quality, and a fast Haiku classifier decides which tier the two research subagents run on.

1. **Difficulty classifier** — Haiku reads the user question and emits a single token: `easy` or `complex`. Short conceptual questions ("how do I sign in?") classify as easy; questions plus stack traces, multi-part debugging, or framework-specific edge cases classify as complex. Defaults to `complex` on any classifier failure so quality wins when in doubt.
2. **Two research subagents — run in parallel.** Each is scoped to exactly one Nia source and exposes one tool:
   - **Repo subagent** → searches the indexed `supabase/supabase-js` GitHub repository (code, types, examples).
   - **Docs subagent** → searches the indexed Supabase JS reference docs (root: `https://supabase.com/docs/reference/javascript/start`).
   - Both subagents run on the same model, chosen by the classifier (Sonnet for `easy`, Opus for `complex`). Each issues 1–3 focused Nia searches and returns structured `Findings / Code / Gaps` text — **not** a final email.
   - Subagents run concurrently with `Promise.allSettled` and an independent 35s timeout each, so one slow or failed source doesn't block the other.
3. **Master synthesizer** — Haiku. Receives the original question plus both subagents' `Findings` blocks and compiles the email reply. No tools, no extended thinking — the work is mechanical reconciliation and formatting (prefer docs for usage, prefer repo for type signatures, mix citations from both).
4. **Fallbacks.** If the Claude pipeline fails or both subagents return empty, drop to an OpenAI call seeded with parallel Nia retrievals from both sources. If that also fails, return a static "busy" message.

### Model choices

| Stage | Model | Why |
|---|---|---|
| Difficulty classifier | `claude-haiku-4-5-20251001` | One-token verdict; sub-second; cheap |
| Subagent (easy queries) | `claude-sonnet-4-6` | Sufficient research quality for simple questions |
| Subagent (complex queries) | `claude-opus-4-7` | Strongest reasoning for debugging / multi-part questions |
| Master synthesizer | `claude-haiku-4-5-20251001` | Merging pre-structured findings into an email — no novel reasoning needed |
| OpenAI fallback | `gpt-5.5-medium` | Independent failure path so a Claude/Anthropic outage isn't fatal |

The response's `stopReason` encodes the path taken: `claude_multi_agent:easy`, `claude_multi_agent:complex`, `openai_fallback`, or `busy_fallback`. Grep production logs on these to validate classifier calls and tail latency.

### One-time setup: index the docs source in Nia

The repo source is indexed automatically the first time it's queried, but the docs source needs to be created once via `indexDocumentation` (in `src/lib/nia.ts`). Run it from a Node REPL or a one-off script with `NIA_API_KEY` set:

```ts
import { indexDocumentation } from "@/lib/nia";

await indexDocumentation("https://supabase.com/docs/reference/javascript/start", {
  crawlEntireDomain: false,
  checkLlmsTxt: true,
  displayName: "supabase-docs",
});
```

Indexing takes a few minutes. Poll `getSource(id)` until `status` reaches `completed` / `indexed` before the docs subagent will return useful results.

## Endpoints (after deploy)

- `GET /api/health`
- `POST /api/agentmail/webhook`
- `POST /api/query` (internal helper: JSON `{ "query": "..." }`)

## Local dev

```bash
npm install
npm run dev
```

Health check:

- `http://localhost:3000/api/health`

Query endpoint quick test (requires `ANTHROPIC_API_KEY` + `NIA_API_KEY`):

```bash
curl -sS -X POST "http://localhost:3000/api/query" \
  -H "Content-Type: application/json" \
  -d '{"query":"How do I sign in with email+password in supabase-js?"}'
```

## Vercel setup

1. Push this repo to GitHub (Vercel is already linked).
2. In Vercel project settings, add Environment Variables:
   - `AGENTMAIL_API_KEY`
   - `NIA_API_KEY`
   - `ANTHROPIC_API_KEY`
3. Deploy.
4. In AgentMail, create a webhook and set **Endpoint URL** to:
   - `https://<your-vercel-domain>/api/agentmail/webhook`

## AgentMail setup (demo checklist)

- Create an AgentMail inbox address (e.g. `support@...`).
- Configure a webhook pointing at `POST /api/agentmail/webhook`.
- Send a test email and confirm:
  - First email returns **clarifying questions** when vague.
  - Second email returns a **grounded answer** with:
    - a copy/paste code block
    - at least one file citation like `[supabase-js/path/to/file.ts]`

## 90-second demo script (rehearsal)

1. Email: “Trying to set up auth with supabase-js. Can’t get sign-in to work. Help?”
2. Agent replies with 1–3 clarifying questions.
3. Reply: “Next.js 14 App Router. Email + password. `signIn` succeeds but session isn’t persisting across reloads.”
4. Agent replies with grounded diagnosis + code + citations.

## Notes

- `.env.example` documents required env vars. Do not commit real secrets.
- This runs on Vercel, so thread state is stored “in-band” in the email thread (a small encoded marker), not in server memory.
