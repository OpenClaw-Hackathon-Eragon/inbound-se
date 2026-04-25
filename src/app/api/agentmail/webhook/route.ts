import { NextResponse } from "next/server";
import { AgentMailClient } from "agentmail";

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
  // eslint-disable-next-line no-var
  var __agentmailSeenMessageIds: Set<string> | undefined;
}

const seenMessageIds =
  globalThis.__agentmailSeenMessageIds ?? new Set<string>();
globalThis.__agentmailSeenMessageIds = seenMessageIds;

function getTextForReply(event: AgentMailMessageReceivedEvent) {
  const from = event.message.from ?? "there";
  const subject = event.message.subject ?? "(no subject)";
  return [
    `Got it — thanks!`,
    ``,
    `I received your message from: ${from}`,
    `Subject: ${subject}`,
    ``,
    `Quick clarifying questions so I can answer precisely:`,
    `1) What language/runtime are you using (Node/Python/etc)?`,
    `2) Are you evaluating us vs a competitor? If so, which one?`,
    `3) What’s your timeline (this week / this month)?`,
    ``,
    `— Inbound (AI SE)`,
  ].join("\n");
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid JSON body";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  const event = payload as Partial<AgentMailMessageReceivedEvent>;
  if (event?.event_type !== "message.received" || event?.type !== "event") {
    return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
  }

  const inboxId = event.message?.inbox_id;
  const messageId = event.message?.message_id;
  if (!inboxId || !messageId) {
    return NextResponse.json(
      { ok: false, error: "Missing inbox_id or message_id" },
      { status: 400 },
    );
  }

  if (seenMessageIds.has(messageId)) {
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
  const replyText = getTextForReply(event as AgentMailMessageReceivedEvent);

  try {
    const reply = await client.inboxes.messages.reply(inboxId, messageId, {
      text: replyText,
    });

    return NextResponse.json({ ok: true, replied: true, reply }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Reply failed";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    );
  }
}

