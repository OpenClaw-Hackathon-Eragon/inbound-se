import { NextResponse } from "next/server";

type UnknownRecord = Record<string, unknown>;

export async function POST(request: Request) {
  let payload: UnknownRecord | null = null;
  let parseError: string | null = null;

  try {
    payload = (await request.json()) as UnknownRecord;
  } catch (err) {
    parseError =
      err instanceof Error ? err.message : "Unable to parse JSON body";
  }

  // For hackathon speed, we just log the incoming event payload.
  // Once we confirm AgentMail's exact event schema, we will:
  // - extract thread/message IDs
  // - call AgentMail API to reply on-thread
  // - (later) call Nia for research + citations
  console.log("agentmail.webhook", {
    receivedAt: new Date().toISOString(),
    headers: {
      "user-agent": request.headers.get("user-agent"),
      "content-type": request.headers.get("content-type"),
    },
    parseError,
    payload,
  });

  return NextResponse.json(
    {
      ok: true,
      received: payload !== null,
      parseError,
    },
    { status: payload ? 200 : 400 },
  );
}

