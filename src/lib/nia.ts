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
): Promise<T> {
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
    throw new Error(`Nia ${init.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText} ${body}`);
  }

  return (await res.json()) as T;
}

export async function indexRepository(repository: string): Promise<NiaSource> {
  return niaFetch<NiaSource>("/sources", {
    method: "POST",
    body: JSON.stringify({ type: "repository", repository }),
  });
}

export async function getSource(sourceId: string): Promise<NiaSource> {
  return niaFetch<NiaSource>(`/sources/${sourceId}`);
}

export type NiaSearchResult = {
  // Nia's search response shape isn't strongly documented; pass through and
  // let the agent reason about whatever fields come back.
  [key: string]: unknown;
};

export async function searchRepository(args: {
  query: string;
  repositories: string[];
}): Promise<NiaSearchResult> {
  return niaFetch<NiaSearchResult>("/search", {
    method: "POST",
    body: JSON.stringify({
      mode: "query",
      messages: [{ role: "user", content: args.query }],
      repositories: args.repositories,
    }),
  });
}
