import { NextResponse } from "next/server";

import { prepareResponse } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { query?: unknown };
  try {
    body = (await request.json()) as { query?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Body must be valid JSON" },
      { status: 400 },
    );
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json(
      { error: "Missing 'query' string in request body" },
      { status: 400 },
    );
  }

  try {
    const result = await prepareResponse(query);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("query.handler", { message });
    return NextResponse.json(
      { error: "Failed to prepare response", detail: message },
      { status: 500 },
    );
  }
}
