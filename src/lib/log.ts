type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCtx = {
  traceId?: string;
  component?: string;
};

function shouldLogDebug(): boolean {
  return process.env.DEBUG === "1" || process.env.LOG_LEVEL === "debug";
}

function shouldLogBodies(): boolean {
  return process.env.LOG_LLM_BODIES === "1";
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) => {
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "string" && v.length > 2000) return `${v.slice(0, 2000)}…`;
        return v;
      }),
    );
  } catch {
    return "[unserializable]";
  }
}

function redact(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (
      key.includes("api_key") ||
      key === "authorization" ||
      key.includes("token") ||
      key.includes("secret") ||
      key.includes("password")
    ) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = redact(v);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const anyErr = err as Error & { cause?: unknown; status?: unknown; code?: unknown };
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: anyErr.code,
      status: anyErr.status,
      cause: anyErr.cause ? safeJson(anyErr.cause) : undefined,
    };
  }
  return { message: String(err) };
}

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
  ctx: LogCtx = {},
): void {
  if (level === "debug" && !shouldLogDebug()) return;
  const redacted = redact(safeJson(fields));
  const payload = {
    ts: nowIso(),
    level,
    msg,
    traceId: ctx.traceId,
    component: ctx.component,
    ...(isPlainObject(redacted) ? redacted : { fields: redacted }),
  };

  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(JSON.stringify(payload));
}

export async function withSpan<T>(
  name: string,
  run: () => Promise<T>,
  ctx: LogCtx,
  fields: Record<string, unknown> = {},
): Promise<T> {
  const start = Date.now();
  log("info", `${name}.start`, fields, ctx);
  try {
    const res = await run();
    log("info", `${name}.ok`, { ...fields, durationMs: Date.now() - start }, ctx);
    return res;
  } catch (err) {
    log(
      "error",
      `${name}.error`,
      { ...fields, durationMs: Date.now() - start, error: serializeError(err) },
      ctx,
    );
    throw err;
  }
}

export function summarizeText(text: string): { len: number; preview?: string } {
  const trimmed = text ?? "";
  const len = trimmed.length;
  if (!shouldLogBodies()) return { len };
  return { len, preview: trimmed.slice(0, 500) };
}

