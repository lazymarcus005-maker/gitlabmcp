/**
 * Response shaping (architecture §7, FR-13): size-cap large payloads,
 * truncating from the START so the latest content survives (e.g. job
 * traces), and carrying `truncated: true` plus a continuation hint.
 * Reusable by any tool (mr.diff, repository.tree, list results, job.trace).
 */
export interface TruncationOptions {
  /** Cap in bytes; payloads at or below the cap pass through untouched. */
  maxBytes: number;
  /** Continuation hint, e.g. "pass offset=N to gitlab_job_trace". */
  continuationHint?: string;
}

export interface ShapedTextResponse {
  content: string;
  truncated: boolean;
  original_bytes: number;
  /** Present only when truncated and a hint was provided. */
  continuation_hint?: string;
}

/**
 * Truncates text from the start (keeping the END) so the result fits in
 * `maxBytes` UTF-8 bytes. Never splits a multi-byte character: the cut
 * point is walked back to a UTF-8 leading byte when necessary.
 */
export function truncateFromStart(
  text: string,
  options: TruncationOptions,
): ShapedTextResponse {
  const originalBytes = Buffer.byteLength(text, "utf8");
  const { maxBytes, continuationHint } = options;
  if (originalBytes <= maxBytes) {
    return { content: text, truncated: false, original_bytes: originalBytes };
  }

  const buffer = Buffer.from(text, "utf8");
  const kept = buffer.subarray(buffer.length - maxBytes);
  // Walk forward past any UTF-8 continuation bytes so we start on a
  // leading byte (multi-byte characters are dropped whole).
  let start = 0;
  while (start < kept.length && (kept[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  const content = kept.subarray(start).toString("utf8");

  const shaped: ShapedTextResponse = {
    content,
    truncated: true,
    original_bytes: originalBytes,
  };
  if (continuationHint) {
    shaped.continuation_hint = continuationHint;
  }
  return shaped;
}
