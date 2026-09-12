/**
 * Typed gateway/tool errors (FR-15). Rendered as `ERROR <CODE>: <message>`
 * inside an MCP tool result with isError: true — never as transport errors.
 */
export class GatewayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }

  toText(): string {
    return `ERROR ${this.code}: ${this.message}`;
  }
}

export const ErrorCodes = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  GITLAB_HOST_NOT_ALLOWED: "GITLAB_HOST_NOT_ALLOWED",
  POLICY_TLS_VERIFY_FORBIDDEN: "POLICY_TLS_VERIFY_FORBIDDEN",
  GITLAB_TOKEN_INVALID: "GITLAB_TOKEN_INVALID",
  GITLAB_API_ERROR: "GITLAB_API_ERROR",
  GITLAB_TIMEOUT: "GITLAB_TIMEOUT",
  GITLAB_RATE_LIMITED: "GITLAB_RATE_LIMITED",
  GITLAB_NOT_SUPPORTED: "GITLAB_NOT_SUPPORTED",
  SCOPE_PROJECT_NOT_ALLOWED: "SCOPE_PROJECT_NOT_ALLOWED",
  POLICY_SCOPE_MISSING: "POLICY_SCOPE_MISSING",
  POLICY_OPERATION_DENIED: "POLICY_OPERATION_DENIED",
  POLICY_BRANCH_PROTECTED: "POLICY_BRANCH_PROTECTED",
} as const;
