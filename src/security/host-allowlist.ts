/**
 * Stage 2a of the security gateway: host allowlist (FR-4, SSRF guard).
 * Allowlist entries are exact matches: `hostname` (any port) or
 * `hostname:port` (that port only).
 */
import { ErrorCodes, GatewayError } from "../errors.js";

export class HostAllowlist {
  private readonly bareHosts: Set<string>;
  private readonly hostPorts: Set<string>;

  constructor(allowedHosts: readonly string[]) {
    this.bareHosts = new Set();
    this.hostPorts = new Set();
    for (const entry of allowedHosts) {
      const trimmed = entry.trim().toLowerCase();
      if (!trimmed) continue;
      if (trimmed.includes(":")) {
        this.hostPorts.add(trimmed);
      } else {
        this.bareHosts.add(trimmed);
      }
    }
  }

  check(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new GatewayError(
        ErrorCodes.GITLAB_HOST_NOT_ALLOWED,
        "X-GitLab-URL is not a valid absolute URL",
      );
    }
    const host = parsed.host.toLowerCase(); // hostname[:port]
    const hostname = parsed.hostname.toLowerCase();
    const allowed = this.hostPorts.has(host) || this.bareHosts.has(hostname);
    if (!allowed) {
      throw new GatewayError(
        ErrorCodes.GITLAB_HOST_NOT_ALLOWED,
        `host '${host}' is not in the allowlist`,
      );
    }
  }

  isAllowed(url: string): boolean {
    try {
      this.check(url);
      return true;
    } catch {
      return false;
    }
  }
}
