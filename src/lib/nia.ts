import { log, serializeError, type LogCtx } from "./log";

const NIA_BASE_URL = "https://apigcp.trynia.ai/v2";

export type NiaSourceStatus =
  | "indexing"
  | "completed"
  | "ready"
  | "indexed"
  | "failed"
  | string;

export type NiaSource = {
  id: string;
  type: string;
  display_name: string;
  status: NiaSourceStatus;
  identifier: string;
};

function apiKey(): string {
  const key = process.env.NIA_API_KEY;
  if (!key) {
    throw new Error("NIA_API_KEY is not set");
  }
  return key;
}

async function niaFetch<T>(
  path: string,
  init: RequestInit = {},
  ctx: LogCtx = {},
): Promise<T> {
  const start = Date.now();
  const res = await fetch(`${NIA_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log(
      "error",
      "nia.fetch.error",
      {
        method: init.method ?? "GET",
        path,
        status: res.status,
        statusText: res.statusText,
        durationMs: Date.now() - start,
        bodyPreview: body.slice(0, 1000),
      },
      { ...ctx, component: "nia" },
    );
    throw new Error(`Nia ${init.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText} ${body}`);
  }

  try {
    const json = (await res.json()) as T;
    log(
      "debug",
      "nia.fetch.ok",
      {
        method: init.method ?? "GET",
        path,
        status: res.status,
        durationMs: Date.now() - start,
      },
      { ...ctx, component: "nia" },
    );
    return json;
  } catch (err) {
    log(
      "error",
      "nia.fetch.parse_error",
      {
        method: init.method ?? "GET",
        path,
        status: res.status,
        durationMs: Date.now() - start,
        error: serializeError(err),
      },
      { ...ctx, component: "nia" },
    );
    throw err;
  }
}

export async function indexRepository(repository: string, ctx: LogCtx = {}): Promise<NiaSource> {
  return niaFetch<NiaSource>(
    "/sources",
    {
    method: "POST",
    body: JSON.stringify({ type: "repository", repository }),
    },
    ctx,
  );
}

export async function getSource(sourceId: string, ctx: LogCtx = {}): Promise<NiaSource> {
  return niaFetch<NiaSource>(`/sources/${sourceId}`, {}, ctx);
}

export type NiaSearchResult = {
  // Nia's search response shape isn't strongly documented; pass through and
  // let the agent reason about whatever fields come back.
  [key: string]: unknown;
};

export async function searchRepository(args: {
  query: string;
  repositories: string[];
  ctx?: LogCtx;
}): Promise<NiaSearchResult> {
  const ctx = args.ctx ?? {};
  log(
    "info",
    "nia.search.start",
    { repositories: args.repositories, queryPreview: args.query.slice(0, 300), queryLen: args.query.length },
    { ...ctx, component: "nia" },
  );
  try {
    const res = await niaFetch<NiaSearchResult>(
      "/search",
      {
        method: "POST",
        body: JSON.stringify({
          mode: "query",
          messages: [{ role: "user", content: args.query }],
          repositories: args.repositories,
        }),
      },
      ctx,
    );
    log("info", "nia.search.ok", { repositories: args.repositories }, { ...ctx, component: "nia" });
    return res;
  } catch (err) {
    log(
      "error",
      "nia.search.error",
      { repositories: args.repositories, error: serializeError(err) },
      { ...ctx, component: "nia" },
    );
    throw err;
  }
}
