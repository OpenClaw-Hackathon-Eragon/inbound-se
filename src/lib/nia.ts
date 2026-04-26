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

export type IndexRepositoryOptions = {
  branch?: string;
  ref?: string;
  displayName?: string;
  projectId?: string;
};

export async function indexRepository(
  repository: string,
  options: IndexRepositoryOptions = {},
  ctx: LogCtx = {},
): Promise<NiaSource> {
  return niaFetch<NiaSource>(
    "/sources",
    {
      method: "POST",
      body: JSON.stringify({
        type: "repository",
        repository,
        branch: options.branch,
        ref: options.ref,
        display_name: options.displayName,
        project_id: options.projectId,
      }),
    },
    ctx,
  );
}

export type IndexDocumentationOptions = {
  urlPatterns?: string[];
  excludePatterns?: string[];
  maxDepth?: number;
  crawlEntireDomain?: boolean;
  checkLlmsTxt?: boolean;
  displayName?: string;
};

export async function indexDocumentation(
  url: string,
  options: IndexDocumentationOptions = {},
  ctx: LogCtx = {},
): Promise<NiaSource> {
  return niaFetch<NiaSource>(
    "/sources",
    {
      method: "POST",
      body: JSON.stringify({
        type: "documentation",
        url,
        url_patterns: options.urlPatterns,
        exclude_patterns: options.excludePatterns,
        max_depth: options.maxDepth,
        crawl_entire_domain: options.crawlEntireDomain,
        check_llms_txt: options.checkLlmsTxt,
        display_name: options.displayName,
      }),
    },
    ctx,
  );
}

export async function indexResearchPaper(
  url: string,
  options: { displayName?: string } = {},
  ctx: LogCtx = {},
): Promise<NiaSource> {
  return niaFetch<NiaSource>(
    "/sources",
    {
      method: "POST",
      body: JSON.stringify({
        type: "research_paper",
        url,
        display_name: options.displayName,
      }),
    },
    ctx,
  );
}

export async function indexHuggingfaceDataset(
  repository: string,
  options: { displayName?: string } = {},
  ctx: LogCtx = {},
): Promise<NiaSource> {
  return niaFetch<NiaSource>(
    "/sources",
    {
      method: "POST",
      body: JSON.stringify({
        type: "huggingface_dataset",
        repository,
        display_name: options.displayName,
      }),
    },
    ctx,
  );
}

export type LocalFolderFile = {
  path: string;
  content: string;
};

export type IndexLocalFolderOptions = {
  folderName?: string;
  folderPath?: string;
  files?: LocalFolderFile[];
  displayName?: string;
};

export async function indexLocalFolder(
  options: IndexLocalFolderOptions,
  ctx: LogCtx = {},
): Promise<NiaSource> {
  return niaFetch<NiaSource>(
    "/sources",
    {
      method: "POST",
      body: JSON.stringify({
        type: "local_folder",
        folder_name: options.folderName,
        folder_path: options.folderPath,
        files: options.files,
        display_name: options.displayName,
      }),
    },
    ctx,
  );
}

export async function getSource(sourceId: string, ctx: LogCtx = {}): Promise<NiaSource> {
  return niaFetch<NiaSource>(`/sources/${sourceId}`, {}, ctx);
}

export type ListSourcesFilters = {
  type?: NiaSource["type"];
  query?: string;
  status?: NiaSourceStatus;
  categoryId?: string;
  limit?: number;
  offset?: number;
};

export type ListSourcesResponse = {
  items: NiaSource[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  };
};

export async function listSources(
  filters: ListSourcesFilters = {},
  ctx: LogCtx = {},
): Promise<ListSourcesResponse> {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.query) params.set("query", filters.query);
  if (filters.status) params.set("status", filters.status);
  if (filters.categoryId) params.set("category_id", filters.categoryId);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.offset !== undefined) params.set("offset", String(filters.offset));
  const qs = params.toString();
  return niaFetch<ListSourcesResponse>(`/sources${qs ? `?${qs}` : ""}`, {}, ctx);
}

export type NiaSearchResult = {
  // Nia's search response shape isn't strongly documented; pass through and
  // let the agent reason about whatever fields come back.
  [key: string]: unknown;
};

export type SearchSourcesArgs = {
  query: string;
  repositories?: string[];
  dataSources?: string[];
  ctx?: LogCtx;
};

export async function searchSources(args: SearchSourcesArgs): Promise<NiaSearchResult> {
  const ctx = args.ctx ?? {};
  const repositories = args.repositories ?? [];
  const dataSources = args.dataSources ?? [];
  log(
    "info",
    "nia.search.start",
    {
      repositories,
      dataSources,
      queryPreview: args.query.slice(0, 300),
      queryLen: args.query.length,
    },
    { ...ctx, component: "nia" },
  );
  try {
    const body: Record<string, unknown> = {
      mode: "query",
      messages: [{ role: "user", content: args.query }],
    };
    if (repositories.length) body.repositories = repositories;
    if (dataSources.length) body.data_sources = dataSources;
    const res = await niaFetch<NiaSearchResult>(
      "/search",
      { method: "POST", body: JSON.stringify(body) },
      ctx,
    );
    log(
      "info",
      "nia.search.ok",
      { repositories, dataSources },
      { ...ctx, component: "nia" },
    );
    return res;
  } catch (err) {
    log(
      "error",
      "nia.search.error",
      { repositories, dataSources, error: serializeError(err) },
      { ...ctx, component: "nia" },
    );
    throw err;
  }
}

export async function searchRepository(args: {
  query: string;
  repositories: string[];
  ctx?: LogCtx;
}): Promise<NiaSearchResult> {
  return searchSources({
    query: args.query,
    repositories: args.repositories,
    ctx: args.ctx,
  });
}
