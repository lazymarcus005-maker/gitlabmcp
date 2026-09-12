/**
 * Capability check (FR-16, architecture §6): on startup call
 * `GET /api/v4/version` and log the GitLab version once. The result is
 * informational only — no dynamic tool gating; unsupported operations fail
 * at call time with GITLAB_NOT_SUPPORTED.
 */
import type { GitLabClient } from "./client-factory.js";

let logged = false;

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
