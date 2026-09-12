/**
 * Project Scope matcher (FR-8): glob patterns like `itrend/*` bound every
 * tool call in the request. `*` matches across path segments so a wildcard
 * covers projects AND groups nested under it (e.g. `itrend/team/alpha`).
 * A trailing `/*` also admits the prefix group itself (`itrend/*` covers
 * the `itrend` group), since groups are first-class scope targets.
 * Matching is case-insensitive; patterns without globs are exact paths.
 */
function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compiles one glob pattern into a RegExp over `namespace/path` targets. */
export function compileProjectGlob(pattern: string): RegExp {
  const trimmed = pattern.trim();
  let source = "";
  for (const ch of trimmed) {
    source += ch === "*" ? ".*" : escapeLiteral(ch);
  }
  // A trailing `/*` also matches the bare prefix group.
  if (trimmed.endsWith("/*")) {
    source = `${source.slice(0, -3)}(?:/.*)?`;
  }
  return new RegExp(`^${source}$`, "i");
}

/**
 * True when the target project/group path is inside the Project Scope.
 * An empty/absent pattern list means "no reduction" (all targets allowed) —
 * the header itself, when present, always carries at least one pattern.
 */
export function projectMatchesScope(
  target: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return true;
  const normalized = target.trim().replace(/^\/+|\/+$/g, "");
  if (normalized === "") return false;
  return patterns.some((p) => compileProjectGlob(p).test(normalized));
}
