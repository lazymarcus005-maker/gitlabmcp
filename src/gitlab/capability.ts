/**
 * Capability check (FR-16, architecture §6): on startup call
 * `GET /api/v4/version` and log the GitLab version once. The result is
 * informational only — no dynamic tool gating; unsupported operations fail
 * at call time with GITLAB_NOT_SUPPORTED.
 */
import type { GitLabClient } from "./client-factory.js";

let logged = false;
/** Version observed from /api/v4/version; the "capabilities seen at startup" view. */
let lastSeenVersion: string | undefined;

export function recordCapabilityVersion(version: string): void {
  lastSeenVersion = version;
}

/** What the server has seen of the GitLab instance so far (never fatal). */
export function getCapabilitySnapshot(): { version?: string } {
  return { version: lastSeenVersion };
}

export function resetCapabilityLog(): void {
  logged = false;
}

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Fetches and logs the GitLab version. Logs at most once per process
 * ("log once"); failures are logged as a warning and never fatal — the
 * server does not disable tools based on capability.
 */
export async function logCapabilityOnce(
  client: GitLabClient,
  log: (line: string) => void = emit,
): Promise<void> {
  if (logged) return;
  logged = true;
  try {
    const version = await client.getJson<{ version?: string }>("/api/v4/version");
    lastSeenVersion = version.version ?? lastSeenVersion;
    log(
      JSON.stringify({
        msg: "gitlab capability check",
        version: version.version ?? "unknown",
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      JSON.stringify({
        msg: "gitlab capability check failed (continuing)",
        error: message,
      }),
    );
  }
}
