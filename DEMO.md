# Demo scenarios — Inbound (supabase-js SE agent)

This is the runbook for the live demo at 6:15. Every scenario here is a real
email you can forward to the AgentMail inbox **or** trigger via the
`/api/query` endpoint as a backup if the inbox is misbehaving.

The strategic frame: judges (Michael at AgentMail, Arlan at Nia, the Eragon
team) do inbound SE work every day. The agent answers technical prospect
questions about `supabase-js` using grounded citations from the repo and the
official JS reference docs — no hallucinations, no fluff.

---

## Pre-demo checklist (run before 6:15)

Run all four of these in order. If anything fails, fix before going live.

### 1. Confirm both Nia sources are indexed

```bash
# List sources, look for status: completed/indexed on both
curl -sS "https://apigcp.trynia.ai/v2/sources?limit=50" \
  -H "Authorization: Bearer $NIA_API_KEY" | jq '.items[] | {type, identifier, status}'
```

Required: one `repository` source for `supabase/supabase-js` AND one
`documentation` source rooted at
`https://supabase.com/docs/reference/javascript/start`. If the docs source is
missing, run [the indexing snippet in the README](README.md#one-time-setup-index-the-docs-source-in-nia)
and wait for `status` to settle before demoing.

### 2. Smoke-test the agent end-to-end

```bash
# Easy path — should classify "easy", route to Sonnet, return in <15s
curl -sS -X POST "$BASE_URL/api/query" \
  -H "Content-Type: application/json" \
  -d '{"query":"What does signInWithPassword return on success?"}' | jq

# Complex path — should classify "complex", route to Opus, return in <45s
curl -sS -X POST "$BASE_URL/api/query" \
  -H "Content-Type: application/json" \
  -d '{"query":"Realtime postgres_changes subscription stops firing after ~5 min on Vercel. No errors. We are using @supabase/supabase-js 2.x. What is going on?"}' | jq
```

Both must return non-empty text with at least one citation in
`[supabase-js/...]` or `[supabase-docs/...]` format.

### 3. Confirm the AgentMail webhook is live

Forward `tests/inbox-smoke.eml` (or any short email) to your inbox. You should
see a reply land in the same thread within ~60s. If not, check Vercel logs for
`agent.prepare.start` and walk the pipeline.

### 4. Record the backup video

Forward Scenario 1 once cleanly. Screen-record from forward → reply landing
→ scrolling the citations. **Always have a backup video.** Wifi at hackathons
dies. The video is your insurance.

---

## Scenario 1 — Hero demo (the one you forward live)

**This is the scenario you forward on stage.** It's tuned to: route to Opus
subagents, force both repo and docs to contribute, and produce a reply with
visible citations from both sources.

**Forward this email:**

```
From: alex@madeupcompany.dev
Subject: Evaluating supabase-js — auth refresh + SSR session persistence

Hey team,

We're evaluating supabase-js for a Next.js 15 App Router app (replacing a
custom NextAuth setup). Two questions before I commit:

1. Does the JS client auto-rotate the JWT, or do I need to wire up the
   refresh flow myself? Looking for the exact method/option name.
2. After signInWithPassword resolves, the session isn't visible on
   server-rendered routes on first request. What's the recommended
   pattern — is it cookies-based, or do I need to forward the access
   token explicitly?

Quick code snippet would help. Thanks!
— Alex
```

**Expected behavior:**

- Difficulty classifier → `complex` (multi-part, framework-specific, debugging
  context).
- Repo subagent (Opus) → finds the auth refresh-token implementation, cites
  `[supabase-js/src/lib/...]`.
- Docs subagent (Opus) → finds the SSR session pattern guide, cites
  `[supabase-docs/...]`.
- Master synthesizer (Haiku) → email reply with: 2–4 sentence direct answer,
  one copy-pasteable code block, "Notes / gotchas" bullets.
- Wall time: 25–45s.
- `stopReason`: `claude_multi_agent:complex`.

**Highlight on stage:**

1. The reply lands in the same email thread (AgentMail threading depth).
2. Open the reply, scroll to the code block — it's not generic, it's grounded
   in real types.
3. Point at the citations — "every claim links back to a file we indexed."
   This is the no-hallucinations story.
4. Bonus: open the cited file in the supabase-js repo to prove it's real.

**Backup if email is slow:**

```bash
curl -sS -X POST "$BASE_URL/api/query" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{"query":"Evaluating supabase-js for Next.js 15 App Router. 1) Does the JS client auto-rotate the JWT or do I need to wire up the refresh flow myself? Exact method/option name? 2) After signInWithPassword resolves, the session is not visible on server-rendered routes on first request. What is the recommended pattern — cookies-based, or do I forward the access token explicitly? Quick code snippet would help."}
JSON
```

---

## Scenario 2 — Cost-routing proof point (easy classification)

**Use this if a judge asks "how do you keep this affordable at scale?"**

**Email body:**

> What does `signInWithPassword` return on success? Just confirming before I
> write the error-handling branch.

**Expected behavior:**

- Difficulty classifier → `easy` (single conceptual lookup, no debugging
  context).
- Both subagents run on **Sonnet 4.6**, not Opus.
- Repo subagent dominates (this is a type-signature question), docs subagent
  may legitimately have "Gaps".
- Wall time: 8–15s.
- `stopReason`: `claude_multi_agent:easy`.

**Highlight on stage:**

- "We classify each inbound on a Haiku call before routing — easy questions
  go to Sonnet, complex to Opus. We don't waste a $15/Mtok model on a type
  lookup."
- Show the difference in `stopReason` between Scenarios 1 and 2.

**Backup:**

```bash
curl -sS -X POST "$BASE_URL/api/query" \
  -H "Content-Type: application/json" \
  -d '{"query":"What does signInWithPassword return on success?"}' | jq -r '.stopReason, .text'
```

---

## Scenario 3 — Multi-source synthesis (debugging)

**Showcases the parallel subagent flow on a question that genuinely needs
both sources.**

**Email body:**

> Realtime `postgres_changes` subscription drops silently after ~5 min on
> Vercel. No errors thrown. Is there a heartbeat / keep-alive config, or is
> this a serverless-runtime thing?

**Expected behavior:**

- Difficulty → `complex`.
- Repo subagent finds the realtime client config and any timeout constants
  (cite `[supabase-js/src/...]`).
- Docs subagent finds the deployment guidance and recommended client config
  (cite `[supabase-docs/...]`).
- Master reconciles both — typical answer mentions both the client option
  AND the runtime constraint.
- `stopReason`: `claude_multi_agent:complex`.

**Highlight on stage:**

- Show citations from BOTH `[supabase-js/...]` and `[supabase-docs/...]` in
  the same reply.
- "The repo tells us what knob exists. The docs tell us how to deploy it.
  Neither source alone gives the right answer — that's why we run them in
  parallel and let a synthesizer reconcile."

---

## Scenario 4 — Graceful "I don't know" (the no-hallucinations proof)

**Use this when a judge tries to break the agent.** Their first instinct
will be to ask something out of scope.

**Email body:**

> Does supabase-js support PartiQL queries? We use that with DynamoDB and
> wondered if there's a similar SQL-ish escape hatch.

**Expected behavior:**

- Both subagents return Findings that don't cover PartiQL. Their `Gaps`
  bullets surface this.
- Master writes a reply that says clearly "this isn't covered in the
  supabase-js repo or the JS reference docs," then pivots to what supabase-js
  *does* support (e.g., raw SQL via `rpc()`, the query builder).
- It does NOT invent a `partiql()` method.

**Highlight on stage:**

- "Watch — it knows what it doesn't know. The hard part of any agent product
  is making it shut up when it should. We give the master a structured
  `Gaps` block from each subagent so it can tell when the sources are silent."

**If asked "how do you guarantee this?":** the subagent system prompts forbid
inventing methods/options/imports, and require citing only paths that
appeared in actual Nia results. The master prompt repeats the same
constraint and treats unavailable findings as a signal to surface the gap,
not to fill it from prior knowledge.

---

## Scenario 5 — The "pre-qualifying lead" angle (optional, only if time)

**Strategic angle from the build plan.** Use this if you have time in Q&A.

**Email body:**

> Hey — using `@supabase/supabase-js` 1.35 in production, considering an
> upgrade. Any breaking changes I should know about?

**What to point out:**

The agent should note that 1.x is well behind current major (2.x at time of
writing) and surface migration guidance from the docs. Frame it as: *"It
didn't just answer the question — it noticed they're on an outdated version
and proactively pulled the migration path."* That's the "Living Technical
Oracle" line from the build plan.

This works because the docs source includes upgrade/migration pages, and
the repo source has the current API surface. The synthesizer naturally
contrasts the two when the user mentions a stale version.

---

## 3-minute demo flow (timing reference)

| Time | Beat | What you say / show |
|---|---|---|
| 0:00–0:20 | The pain | "Every founder in this room is their company's SE. You're answering the same prospect questions at midnight." |
| 0:20–0:40 | The setup | "We forward inbound to one address. The agent searches our repo AND our docs in parallel, then writes a grounded reply. Watch." |
| 0:40–2:00 | **Live demo (Scenario 1)** | Forward → narrate the wait (~30s) → reply lands → open it → scroll to code block → point at citations → open one cited file in the actual repo. |
| 2:00–2:30 | Architecture / cost story | One slide. Nia (2 indexed sources, both load-bearing) + AgentMail (inbox, threading, webhooks) + the model-tier routing (Haiku classify → Sonnet/Opus subagents → Haiku synthesize). |
| 2:30–2:50 | The differentiator | "It cites every claim. It knows what it doesn't know. And it routes by complexity so it's not burning Opus on `getUser()` lookups." |
| 2:50–3:00 | The ask | "We'd ship this Monday. Who wants the beta?" |

---

## Q&A prep — the questions you will get

### "How do you prevent hallucinated code?"

Two lines of defense:

1. Subagent system prompts explicitly forbid inventing methods, options,
   imports, or paths. They cite **only** paths that appeared in real Nia
   results.
2. The master synthesizer doesn't have tools — it only sees the two
   `Findings / Code / Gaps` blocks. It can't go fetch context from anywhere
   the subagents didn't already retrieve.

If a source is silent, the master surfaces the gap rather than filling it.
See Scenario 4.

### "What about prompt injection from the inbound email?"

The email body is treated as untrusted user content, not as an instruction
channel. The system prompts are fixed strings. No tool is invoked based on
the body's *intent* — only the literal Nia search tool, scoped to one source
each, with a query parameter the subagent constructs.

We don't yet sanitize against e.g. embedded `</system>` tags pretending to
be a system message — that's a hardening item for v2.

### "Why two subagents instead of one agent with two tools?"

Three reasons:

1. **Parallelism** — they run concurrently, so wall time is `max(repo, docs)`
   not `repo + docs`.
2. **Failure isolation** — if Nia is slow or one source returns garbage, the
   other still produces useful findings. `Promise.allSettled` keeps the
   pipeline alive on partial failure.
3. **Smaller per-step contexts** — each subagent only reasons over one
   source's results. The master synthesizes from pre-distilled findings, not
   from raw search dumps. Faster, cheaper, fewer tokens of slop to wade
   through.

### "How is this different from `<doc-search-bot competitor>`?"

Doc search bots answer from prose. We answer from **the actual code** —
type signatures, options, real exports. The reply includes the file path,
and you can click through to the line. That's the SE-quality difference.

### "Latency at scale?"

Easy queries (Sonnet path) finish in 8–15s. Complex queries (Opus path) run
~25–45s. The classifier adds ~500ms but pays for itself by routing 60%+ of
inbound to Sonnet. For email turnaround that's fine; for a chatbot UI we'd
stream incremental tokens.

---

## Failure modes & backup plans

| What breaks | Backup |
|---|---|
| AgentMail webhook doesn't fire | Switch to the `curl /api/query` backup commands above. Frame it: "same agent, different transport." |
| Wifi dies entirely | Play the recorded video from the pre-demo checklist. |
| Nia is slow / 5xx | The pipeline degrades to whichever subagent succeeded. The OpenAI fallback also runs both Nia retrievals in parallel and is independent of the Anthropic path. |
| Both Anthropic + Nia down | Static "busy" reply still ships from `BUSY_FALLBACK_TEXT`. Not a demo win, but not a crash. Mention the fallback chain in the architecture slide regardless — judges grade on resilience. |
| Reply quality is mid on the live forward | Have Scenario 3 queued as the next forward. "Let me show you the harder one." |

The cardinal rule: **never debug on stage.** If something breaks, cut to the
backup video, finish the architecture slide, take questions. You can
recover from a bad demo with a sharp Q&A; you cannot recover from a 90-second
silent debugging session.
