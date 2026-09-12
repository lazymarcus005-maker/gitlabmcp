/**
 * Secret redaction (NFR-1): strips token/Authorization/cookie/secret patterns
 * from anything that is about to be logged.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // JSON-shaped keys: "authorization": "..."
  {
    pattern: /("(?:authorization|cookie|token|secret|password|api[-_]key|private[-_]key|access[-_]token)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    replacement: '$1"[REDACTED]"',
  },
  // GitLab PAT shapes and auth header schemes
  { pattern: /glpat-[A-Za-z0-9_-]{8,}/g, replacement: "[REDACTED]" },
  { pattern: /(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{8,}/gi, replacement: "$1 [REDACTED]" },
  // key=value / key: value forms
  {
    pattern: /\b(authorization|cookie)\b\s*[:=]\s*[^\s"',}]+(\s+[^\s"',}]+)?/gi,
    replacement: "$1: [REDACTED]",
  },
  {
    pattern: /\b(token|pat|secret|password|api[-_]?key)\b\s*[:=]\s*[^\s"',}]+/gi,
    replacement: "$1: [REDACTED]",
  },
];

/** Returns a redacted copy of any stringifiable value. */
export function redact<T>(value: T): T {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return value;
  let out = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (typeof value === "string") return out as unknown as T;
  try {
    return JSON.parse(out) as T;
  } catch {
    return value;
  }
}
