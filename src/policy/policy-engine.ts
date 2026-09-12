/**
 * Policy engine (ADR-0002, architecture §5): intersects server policy ∩
 * requested scope ∩ project scope. Fail fast in the documented order;
 * every rejection is a typed GatewayError rendered as an isError tool
 * result (FR-15). Tool handlers declare risk + scope and never implement
 * permission logic themselves.
 */
import { ErrorCodes, GatewayError } from "../errors.js";
import type { GitLabRequestContext } from "../context/request-context.js";
import { projectMatchesScope } from "../security/scope.js";
import type { RiskClass, ToolPolicy } from "./risk.js";

/** Server-side policy knobs (NFR-3), loaded from config. */
export interface PolicyConfig {
  /** GITLAB_MCP_READ_ONLY kill switch: denies everything above READ. */
  readOnly: boolean;
  /** Risk classes allowed by server policy; anything else denied. */
  allowedRiskClasses: RiskClass[];
  /** Branches that deny create AND delete (FR-10 defaults: main/master/uat/production). */
  protectedBranches: string[];
  /** Branches that additionally deny direct delete. */
  denyDirectDeleteBranches: string[];
}

export interface PolicyTarget {
  /** Target project (`namespace/path`) when the tool names one. */
  project?: string;
  /** Target group when the tool is group-scoped. */
  group?: string;
  /** Target branch for branch-mutating tools. */
  branch?: string;
}

/**
 * Runs the decision pipeline in order; throws GatewayError on the first
 * failure. Passing does NOT mean GitLab will allow the call — GitLab's own
 * permission check remains the final gate (FR-6).
 */
export function evaluatePolicy(
  ctx: GitLabRequestContext,
  policy: PolicyConfig,
  tool: ToolPolicy,
  target: PolicyTarget,
): void {
  // 1. Read-only kill switch (NFR-3): deny everything above READ.
  if (policy.readOnly && tool.riskClass !== "READ") {
    throw new GatewayError(
      ErrorCodes.POLICY_OPERATION_DENIED,
      `server is in read-only mode (GITLAB_MCP_READ_ONLY=true); ${tool.riskClass} operations are denied`,
    );
  }

  // 2. Risk class denied by server policy (DESTRUCTIVE defaults to deny).
  if (!policy.allowedRiskClasses.includes(tool.riskClass)) {
    throw new GatewayError(
      ErrorCodes.POLICY_OPERATION_DENIED,
      `risk class ${tool.riskClass} is not allowed by server policy`,
    );
  }

  // 3. Required scope missing from X-GitLab-Request-Scope. An absent header
  //    grants all scopes; a present header only reduces. Unknown values
  //    (e.g. `admin`) grant nothing (FR-7).
  if (tool.requiredScope && tool.riskClass !== "READ") {
    const requested = ctx.requestedScopes;
    if (requested !== undefined && !requested.includes(tool.requiredScope)) {
      throw new GatewayError(
        ErrorCodes.POLICY_SCOPE_MISSING,
        `requested scope does not include '${tool.requiredScope}' (required for this operation)`,
      );
    }
  }

  // 4. Target project/group inside Project Scope (FR-8).
  if (target.project !== undefined || target.group !== undefined) {
    const patterns = ctx.projectScope;
    if (patterns && patterns.length > 0) {
      if (target.project !== undefined && !projectMatchesScope(target.project, patterns)) {
        throw new GatewayError(
          ErrorCodes.SCOPE_PROJECT_NOT_ALLOWED,
          `project '${target.project}' is outside the request's Project Scope`,
        );
      }
      if (target.group !== undefined && !projectMatchesScope(target.group, patterns)) {
        throw new GatewayError(
          ErrorCodes.SCOPE_PROJECT_NOT_ALLOWED,
          `group '${target.group}' is outside the request's Project Scope`,
        );
      }
    }
  }

  // 5. Branch guardrails (FR-10): protected branches deny create-on-protected
  //    and delete; deny_direct_delete additionally gates delete.
  if (tool.branchOperation && target.branch !== undefined) {
    const branch = target.branch.trim().toLowerCase();
    const op = tool.branchOperation;
    if (policy.protectedBranches.some((b) => b.trim().toLowerCase() === branch)) {
      throw new GatewayError(
        ErrorCodes.POLICY_BRANCH_PROTECTED,
        `branch '${target.branch}' is protected; ${op === "delete" ? "delete" : "create"} is denied`,
      );
    }
    if (
      op === "delete" &&
      policy.denyDirectDeleteBranches.some((b) => b.trim().toLowerCase() === branch)
    ) {
      throw new GatewayError(
        ErrorCodes.POLICY_BRANCH_PROTECTED,
        `direct delete of branch '${target.branch}' is denied by server policy`,
      );
    }
  }
}

/** Default server policy: everything except DESTRUCTIVE, default guardrails. */
export function defaultPolicyConfig(): PolicyConfig {
  return {
    readOnly: false,
    allowedRiskClasses: ["READ", "WRITE", "PRIVILEGED"],
    protectedBranches: ["main", "master", "uat", "production"],
    denyDirectDeleteBranches: [],
  };
}
