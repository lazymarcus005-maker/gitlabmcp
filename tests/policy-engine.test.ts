import { describe, it, expect } from "vitest";
import { evaluatePolicy, defaultPolicyConfig } from "../src/policy/policy-engine.js";
import { ErrorCodes, GatewayError } from "../src/errors.js";
import type { GitLabRequestContext } from "../src/context/request-context.js";
import type { PolicyConfig } from "../src/policy/policy-engine.js";

function makeCtx(overrides: Partial<GitLabRequestContext> = {}): GitLabRequestContext {
  return {
    requestId: "req-test",
    gitlab: { baseUrl: "https://git.tiddaw.net", token: "glpat-x", tls: { verify: true } },
    identity: { id: 42, username: "marcus" },
    ...overrides,
  };
}

function makePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return { ...defaultPolicyConfig(), ...overrides };
}

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
    expect.fail(`expected ${code}`);
  } catch (e) {
    if (e instanceof GatewayError) {
      expect(e.code).toBe(code);
    } else {
      throw e;
    }
  }
}

const WRITE_TOOL = { riskClass: "WRITE" as const, requiredScope: "issue-write" as const };

describe("evaluatePolicy — decision order", () => {
  it("passes a compliant WRITE call with no scope header (all scopes granted)", () => {
    expect(() =>
      evaluatePolicy(makeCtx(), makePolicy(), WRITE_TOOL, { project: "itrend/cxutility" }),
    ).not.toThrow();
  });

  it("1. read-only kill switch denies WRITE/PRIVILEGED/DESTRUCTIVE, allows READ", () => {
    const policy = makePolicy({ readOnly: true });
    expectCode(
      () => evaluatePolicy(makeCtx(), policy, WRITE_TOOL, { project: "itrend/cxutility" }),
      ErrorCodes.POLICY_OPERATION_DENIED,
    );
    expect(() =>
      evaluatePolicy(makeCtx(), policy, { riskClass: "READ" }, {}),
    ).not.toThrow();
  });

  it("2. risk class denied by server policy → POLICY_OPERATION_DENIED (DESTRUCTIVE default)", () => {
    const policy = makePolicy();
    expectCode(
      () => evaluatePolicy(makeCtx(), policy, { riskClass: "DESTRUCTIVE" }, {}),
      ErrorCodes.POLICY_OPERATION_DENIED,
    );
    expectCode(
      () =>
        evaluatePolicy(
          makeCtx(),
          makePolicy({ allowedRiskClasses: ["READ"] }),
          WRITE_TOOL,
          {},
        ),
      ErrorCodes.POLICY_OPERATION_DENIED,
    );
  });

  it("3. missing requested scope → POLICY_SCOPE_MISSING", () => {
    expectCode(
      () =>
        evaluatePolicy(
          makeCtx({ requestedScopes: ["read"] }),
          makePolicy(),
          WRITE_TOOL,
          { project: "itrend/cxutility" },
        ),
      ErrorCodes.POLICY_SCOPE_MISSING,
    );
  });

  it("3b. `X-GitLab-Request-Scope: read` blocks any WRITE", () => {
    const ctx = makeCtx({ requestedScopes: ["read"] });
    expectCode(
      () =>
        evaluatePolicy(ctx, makePolicy(), {
          riskClass: "WRITE",
          requiredScope: "mr-write",
        }, {}),
      ErrorCodes.POLICY_SCOPE_MISSING,
    );
  });

  it("3c. `admin` grants nothing — unknown scope values only reduce", () => {
    const ctx = makeCtx({ requestedScopes: ["admin"] });
    expectCode(
      () => evaluatePolicy(ctx, makePolicy(), WRITE_TOOL, {}),
      ErrorCodes.POLICY_SCOPE_MISSING,
    );
  });

  it("3d. matching scope passes", () => {
    const ctx = makeCtx({ requestedScopes: ["read", "issue-write"] });
    expect(() => evaluatePolicy(ctx, makePolicy(), WRITE_TOOL, {})).not.toThrow();
  });

  it("3e. READ tools never require a scope", () => {
    const ctx = makeCtx({ requestedScopes: ["admin"] });
    expect(() => evaluatePolicy(ctx, makePolicy(), { riskClass: "READ" }, {})).not.toThrow();
  });

  it("4. target outside Project Scope → SCOPE_PROJECT_NOT_ALLOWED (project and group)", () => {
    const ctx = makeCtx({ projectScope: ["itrend/*"] });
    expectCode(
      () => evaluatePolicy(ctx, makePolicy(), WRITE_TOOL, { project: "other/repo" }),
      ErrorCodes.SCOPE_PROJECT_NOT_ALLOWED,
    );
    expectCode(
      () => evaluatePolicy(ctx, makePolicy(), { riskClass: "READ" }, { group: "other" }),
      ErrorCodes.SCOPE_PROJECT_NOT_ALLOWED,
    );
    expect(() =>
      evaluatePolicy(ctx, makePolicy(), WRITE_TOOL, { project: "itrend/team/app" }),
    ).not.toThrow();
  });

  it("4b. decision order: kill switch wins over scope, scope wins over project scope", () => {
    const ctx = makeCtx({ requestedScopes: ["read"], projectScope: ["itrend/*"] });
    const policy = makePolicy({ readOnly: true });
    // Kill switch fires before the scope check even though both would fail.
    expectCode(
      () => evaluatePolicy(ctx, policy, WRITE_TOOL, { project: "other/repo" }),
      ErrorCodes.POLICY_OPERATION_DENIED,
    );
    // Scope check fires before the project scope check.
    expectCode(
      () => evaluatePolicy(ctx, makePolicy(), WRITE_TOOL, { project: "other/repo" }),
      ErrorCodes.POLICY_SCOPE_MISSING,
    );
  });

  it("5. protected branch denies create AND delete", () => {
    const policy = makePolicy();
    const branchTool = (op: "create" | "delete") => ({
      riskClass: "WRITE" as const,
      requiredScope: "repo-write" as const,
      branchOperation: op,
    });
    expectCode(
      () => evaluatePolicy(makeCtx(), policy, branchTool("create"), { branch: "main" }),
      ErrorCodes.POLICY_BRANCH_PROTECTED,
    );
    expectCode(
      () => evaluatePolicy(makeCtx(), policy, branchTool("delete"), { branch: "main" }),
      ErrorCodes.POLICY_BRANCH_PROTECTED,
    );
    expect(() =>
      evaluatePolicy(makeCtx(), policy, branchTool("create"), { branch: "feature/x" }),
    ).not.toThrow();
  });

  it("5b. deny_direct_delete additionally gates delete on non-protected branches", () => {
    const policy = makePolicy({ denyDirectDeleteBranches: ["staging"] });
    const deleteTool = {
      riskClass: "WRITE" as const,
      requiredScope: "repo-write" as const,
      branchOperation: "delete" as const,
    };
    expectCode(
      () => evaluatePolicy(makeCtx(), policy, deleteTool, { branch: "staging" }),
      ErrorCodes.POLICY_BRANCH_PROTECTED,
    );
    // create on the same branch is fine; delete of other branches is fine.
    expect(() =>
      evaluatePolicy(makeCtx(), policy, { ...deleteTool, branchOperation: "create" }, { branch: "staging" }),
    ).not.toThrow();
    expect(() =>
      evaluatePolicy(makeCtx(), policy, deleteTool, { branch: "feature/x" }),
    ).not.toThrow();
  });

  it("5c. branch guardrails only apply to branch-mutating tools", () => {
    const policy = makePolicy({ protectedBranches: ["main"] });
    expect(() =>
      evaluatePolicy(makeCtx(), policy, { riskClass: "READ" }, { branch: "main" }),
    ).not.toThrow();
  });
});

describe("defaultPolicyConfig", () => {
  it("allows READ/WRITE/PRIVILEGED, denies DESTRUCTIVE", () => {
    const policy = defaultPolicyConfig();
    expect(policy.allowedRiskClasses).toEqual(["READ", "WRITE", "PRIVILEGED"]);
    expect(() =>
      evaluatePolicy(makeCtx(), policy, { riskClass: "PRIVILEGED" }, {}),
    ).not.toThrow();
    expectCode(
      () => evaluatePolicy(makeCtx(), policy, { riskClass: "DESTRUCTIVE" }, {}),
      ErrorCodes.POLICY_OPERATION_DENIED,
    );
    expect(policy.protectedBranches).toEqual(["main", "master", "uat", "production"]);
  });
});
