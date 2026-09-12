/**
 * Risk classes and the requested-scope vocabulary (FR-7, architecture §5).
 * Scopes only reduce: `X-GitLab-Request-Scope: admin` grants nothing.
 */
export const RiskClasses = ["READ", "WRITE", "PRIVILEGED", "DESTRUCTIVE"] as const;
export type RiskClass = (typeof RiskClasses)[number];

export const Scopes = [
  "read",
  "issue-write",
  "mr-write",
  "mr-merge",
  "repo-write",
  "pipeline-write",
  "project-write",
] as const;
export type Scope = (typeof Scopes)[number];

export interface BranchOperation {
  /** Operation on the target branch, when the tool mutates branches. */
  operation: "create" | "delete";
}

/**
 * Per-tool policy declaration: handlers declare risk + scope and let the
 * policy engine decide — they never implement permission logic (ADR-0002).
 */
export interface ToolPolicy {
  riskClass: RiskClass;
  /** Minimum scope required from X-GitLab-Request-Scope (READ tools: none). */
  requiredScope?: Scope;
  /** Branch guardrail declaration for branch-mutating tools (FR-10). */
  branchOperation?: BranchOperation["operation"];
}
