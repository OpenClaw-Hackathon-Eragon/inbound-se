# inbound — Hackathon scaffold (AgentMail webhook → Next.js)

This repo is a minimal Next.js app deployed on Vercel and used as the webhook receiver for AgentMail.

It implements an **email-based support agent for `supabase-js`**:

- Inbound email → LLM triage
- If underspecified → 1 clarifying email (hard cap)
- If ready → grounded answer with code + repo file path citations (via Nia over `supabase/supabase-js`)

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
