# inbound — Hackathon scaffold (AgentMail webhook → Next.js)

This repo is a minimal Next.js app meant to be deployed on Vercel and used as the webhook receiver for AgentMail.

## Endpoints (after deploy)

- `GET /api/health`
- `POST /api/agentmail/webhook`

## Local dev

```bash
npm install
npm run dev
```

Health check:

- `http://localhost:3000/api/health`

## Vercel setup

1. Push this repo to GitHub (Vercel is already linked).
2. In Vercel project settings, add Environment Variables:
   - `AGENTMAIL_API_KEY`
   - (later) `NIA_API_KEY`
3. Deploy.
4. In AgentMail, create a webhook and set **Endpoint URL** to:
   - `https://<your-vercel-domain>/api/agentmail/webhook`

## Notes

- `.env.example` documents required env vars. Do not commit real secrets.
- The webhook handler currently logs the payload and returns 200/400; once we paste a sample AgentMail webhook payload, we’ll implement replying on-thread.
