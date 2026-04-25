import { z } from "zod";

export const ThreadStateSchema = z.object({
  round: z.number().int().min(0).max(1).default(0),
  lastStatus: z.enum(["NEED_INFO", "READY"]).optional(),
  structuredQuery: z
    .object({
      question: z.string().min(1),
      feature_area: z.string().min(1).optional(),
      framework: z.string().min(1).optional(),
      goal: z.string().min(1).optional(),
      what_they_tried: z.string().min(1).optional(),
      errors: z.string().min(1).optional(),
      versions: z.string().min(1).optional(),
      context: z.string().min(1).optional(),
    })
    .optional(),
});

export type ThreadState = z.infer<typeof ThreadStateSchema>;

const STATE_PREFIX = "INBOUND_STATE:";

function toBase64Utf8(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function fromBase64Utf8(s: string): string {
  return Buffer.from(s, "base64").toString("utf8");
}

export function encodeThreadState(state: ThreadState): string {
  const normalized = ThreadStateSchema.parse(state);
  return toBase64Utf8(JSON.stringify(normalized));
}

export function decodeThreadState(encoded: string): ThreadState | null {
  try {
    const json = fromBase64Utf8(encoded.trim());
    const parsed = JSON.parse(json) as unknown;
    const res = ThreadStateSchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

export function appendThreadStateMarker(text: string, state: ThreadState): string {
  const encoded = encodeThreadState(state);
  return `${text}\n\n---\n${STATE_PREFIX}${encoded}\n---\n`;
}

export function extractLatestThreadStateFromText(text: string): ThreadState | null {
  if (!text) return null;
  const idx = text.lastIndexOf(STATE_PREFIX);
  if (idx < 0) return null;
  const after = text.slice(idx + STATE_PREFIX.length);
  const firstLine = after.split(/\r?\n/, 1)[0] ?? "";
  return decodeThreadState(firstLine);
}

