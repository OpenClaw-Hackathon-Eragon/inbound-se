import { NextResponse } from "next/server";
import { AgentMailClient } from "agentmail";

import { prepareResponse } from "@/lib/agent";
import { log, serializeError } from "@/lib/log";
import {
  appendThreadStateMarker,
  extractLatestThreadStateFromText,
  type ThreadState,
} from "@/lib/threadState";
import { runTriage } from "@/lib/triage";

export const runtime = "nodejs";

type AgentMailMessageReceivedEvent = {
  type: "event";
  event_id: string;
  event_type: "message.received";
  message: {
    inbox_id: string;
    message_id: string;
    thread_id: string;
    from?: string;
    subject?: string;
    extracted_text?: string;
    extracted_html?: string;
    text?: string;
    html?: string;
  };
};

declare global {
  var __agentmailSeenMessageIds: Set<string> | undefined;
}

const seenMessageIds =
  globalThis.__agentmailSeenMessageIds ?? new Set<string>();
globalThis.__agentmailSeenMessageIds = seenMessageIds;

function normalizeThreadText(event: AgentMailMessageReceivedEvent): string {
  return (
    event.message.extracted_text ??
    event.message.text ??
    event.message.extracted_html ??
    event.message.html ??
    ""
  ).trim();
}

function buildClarifyingEmail(args: {
  subject: string;
  questions: string[];
  state: ThreadState;
}): string {
  const lines = [
    `Happy to help — a few quick questions so I can give you a grounded supabase-js answer:`,
    ``,
    ...args.questions.slice(0, 3).map((q, i) => `${i + 1}. ${q}`),
    ``,
    `Reply here with the answers and I’ll follow up with code and file citations from the supabase-js repo.`,
    ``,
    `— Inbound (supabase-js support)`,
  ];
  return appendThreadStateMarker(lines.join("\n"), args.state);
}

function buildFinalEmail(args: {
  answerText: string;
  state: ThreadState;
}): string {
  return appendThreadStateMarker(args.answerText.trim(), args.state);
}

function buildAgentPrompt(args: {
  triageQuery: Record<string, unknown>;
  threadText: string;
}): string {
  return [
    `You are replying to an email thread. Use the structured triage context below, plus the raw thread excerpt, to answer precisely.`,
    ``,
    `STRUCTURED_QUERY (from triage):`,
    JSON.stringify(args.triageQuery, null, 2),
    ``,
    `RAW_THREAD_EXCERPT:`,
    args.threadText.slice(0, 8000),
  ].join("\n");
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid JSON body";
    log("warn", "agentmail.webhook.invalid_json", { error: message }, { component: "webhook" });
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  const event = payload as Partial<AgentMailMessageReceivedEvent>;
  if (event?.event_type !== "message.received" || event?.type !== "event") {
    return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
  }

  const inboxId = event.message?.inbox_id;
  const messageId = event.message?.message_id;
  const traceId = event.event_id ?? messageId ?? "unknown";
  if (!inboxId || !messageId) {
    log(
      "warn",
      "agentmail.webhook.missing_ids",
      { inboxId: inboxId ?? null, messageId: messageId ?? null },
      { traceId, component: "webhook" },
    );
    return NextResponse.json(
      { ok: false, error: "Missing inbox_id or message_id" },
      { status: 400 },
    );
  }

  if (seenMessageIds.has(messageId)) {
    log("info", "agentmail.webhook.deduped", { inboxId, messageId }, { traceId, component: "webhook" });
    return NextResponse.json({ ok: true, deduped: true }, { status: 200 });
  }
  seenMessageIds.add(messageId);

  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "Missing AGENTMAIL_API_KEY env var" },
      { status: 500 },
    );
  }

  const client = new AgentMailClient({ apiKey });
  const typedEvent = event as AgentMailMessageReceivedEvent;
  const threadText = normalizeThreadText(typedEvent);
  const subject = typedEvent.message.subject ?? "(no subject)";

  log(
    "info",
    "agentmail.webhook.received",
    {
      inboxId,
      messageId,
      threadId: typedEvent.message.thread_id,
      subject,
      threadLen: threadText.length,
      hasText: Boolean(typedEvent.message.text || typedEvent.message.extracted_text),
      hasHtml: Boolean(typedEvent.message.html || typedEvent.message.extracted_html),
    },
    { traceId, component: "webhook" },
  );

  const existingState =
    extractLatestThreadStateFromText(threadText) ?? ({ round: 0 } as ThreadState);
  const round: 0 | 1 = existingState.round >= 1 ? 1 : 0;

  try {
    const triage = await runTriage({ thread: threadText, round, ctx: { traceId } });

    if (triage.status === "NEED_INFO") {
      const nextState: ThreadState = {
        round: 1,
        lastStatus: "NEED_INFO",
      };
      const replyText = buildClarifyingEmail({
        subject,
        questions: triage.questions,
        state: nextState,
      });

      log(
        "info",
        "agentmail.webhook.reply.need_info",
        { questions: triage.questions, replyLen: replyText.length },
        { traceId, component: "webhook" },
      );
      const reply = await client.inboxes.messages.reply(inboxId, messageId, {
        text: replyText,
      });

      return NextResponse.json(
        { ok: true, status: "NEED_INFO", replied: true, reply },
        { status: 200 },
      );
    }

    const agentPrompt = buildAgentPrompt({
      triageQuery: triage.query,
      threadText,
    });

    const result = await prepareResponse(agentPrompt, { traceId });
    const nextState: ThreadState = {
      round,
      lastStatus: "READY",
      structuredQuery: triage.query,
    };
    const replyText = buildFinalEmail({ answerText: result.text, state: nextState });

    log(
      "info",
      "agentmail.webhook.reply.ready",
      { stopReason: result.stopReason, replyLen: replyText.length },
      { traceId, component: "webhook" },
    );
    const reply = await client.inboxes.messages.reply(inboxId, messageId, {
      text: replyText,
    });

    return NextResponse.json(
      { ok: true, status: "READY", replied: true, reply, stopReason: result.stopReason },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Reply failed";
    log(
      "error",
      "agentmail.webhook.error",
      { error: serializeError(err) },
      { traceId, component: "webhook" },
    );
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}

