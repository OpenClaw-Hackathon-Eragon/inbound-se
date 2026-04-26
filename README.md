# inbound-se — Email support agent (AgentMail webhook + Nia-grounded answers)

`inbound` is a minimal Next.js service that receives inbound support emails via **AgentMail**, runs a short **triage → clarifying question (optional) → grounded answer** pipeline, and replies back in-thread.

Grounding comes from **Nia**: you index your docs/KB sources once, then the agent retrieves from those sources and cites them in the reply as `[kb/<path-or-url>]`.

## What this repo provides

- **AgentMail webhook receiver**: `POST /api/agentmail/webhook`
- **Clarifying-question loop (hard cap: 1 round)** for underspecified requests
- **Nia-backed retrieval** for grounded answers (with citations)
- **Model fallback path**: if the primary pipeline fails/returns empty, it falls back to an OpenAI response seeded with Nia retrieval context

## Tech stack

- **Next.js**: 16.x (App Router)
- **Runtime**: Node.js (`export const runtime = "nodejs"`)
- **LLM providers**: Anthropic (primary), OpenAI (fallback)
- **Retrieval**: Nia sources + search
- **Email**: AgentMail inbox + webhook

## Endpoints

- `GET /api/health`
- `POST /api/agentmail/webhook` (AgentMail → this service)
- `POST /api/query` (helper for local testing; JSON `{ "query": "..." }`)

## Prerequisites

- **Node.js**: recommend Node 20+ (works with modern Next.js/TypeScript)
- **AgentMail account** with an inbox + webhook configured
- **Nia account** with at least one indexed source
- **Anthropic API key** (primary) and **OpenAI API key** (fallback)

## Configuration

Create `.env.local` (or set env vars in your deployment target). Use `.env.example` as the source of truth.

Common required env vars:

- `AGENTMAIL_API_KEY`
- `NIA_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY` (recommended; used for fallback)

## Run locally

```bash
npm install
npm run dev
```

Then verify:

- Health: `http://localhost:3000/api/health`

Quick test the query helper (requires `ANTHROPIC_API_KEY` + `NIA_API_KEY`):

```bash
curl -sS -X POST "http://localhost:3000/api/query" \
  -H "Content-Type: application/json" \
  -d '{"query":"How do I do X in the supported library?"}'
```

## One-time: index knowledge sources in Nia

This service searches Nia sources; it does not crawl content itself. Index your documentation/KB in Nia first (docs roots, internal KB pages, etc.).

You can create a Nia documentation source using `indexDocumentation` in `src/lib/nia.ts` from a Node REPL or one-off script (with `NIA_API_KEY` set):

```ts
import { indexDocumentation } from "@/lib/nia";

await indexDocumentation("https://supabase.com/docs/reference/javascript/start", {
  crawlEntireDomain: false,
  checkLlmsTxt: true,
  displayName: "supabase-docs",
});
```

Indexing can take a few minutes. Poll `getSource(id)` until the source status reaches `completed` / `indexed`.

## Deploy

Deploy anywhere that can run a Next.js Node runtime (Vercel, Render, Fly.io, etc.).

Minimal deployment steps:

1. **Set environment variables** (see “Configuration”).
2. **Deploy the app**.
3. In AgentMail, configure a webhook for your inbox:
   - **Method**: `POST`
   - **URL**: `https://<your-domain>/api/agentmail/webhook`
4. Send a test email to your AgentMail inbox and verify:
   - Vague request → **clarifying questions**
   - Detailed request → **grounded answer** with **code** + **`[kb/...]` citations**

## How the “1 clarifying email” cap works

Thread state is stored **in-band** in the email thread (an encoded marker appended to replies), not in server memory. That keeps the service stateless across deploys/cold starts while still enforcing the 1-round clarification cap.

## Security & privacy notes

- **Never commit secrets**. Use `.env.local` for local dev and environment variables for deployments.
- Email content is processed by LLM providers you configure (Anthropic/OpenAI) and Nia (retrieval). Review each vendor’s data handling policies before using this with sensitive content.

## Contributing

Issues and PRs are welcome.

- **Local checks**: `npm run lint`
- **Style**: keep changes small and focus on reliability (webhook robustness, timeouts, logging, and correctness of citations)

## License

This repo does not currently include a license file. If you plan to publish publicly, add a `LICENSE` (MIT/Apache-2.0/etc.) before advertising or accepting external contributions.
