/**
 * Smoke suite (NFR-6, issue #11): runs read-only tools end-to-end against a
 * REAL GitLab instance. Enabled only when GITLAB_MCP_SMOKE_URL and
 * GITLAB_MCP_SMOKE_TOKEN are set; skips cleanly otherwise. No mutations —
 * the tools invoked here are all READ risk class.
 *
 * Run: npm run smoke
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SMOKE_URL = process.env.GITLAB_MCP_SMOKE_URL;
const SMOKE_TOKEN = process.env.GITLAB_MCP_SMOKE_TOKEN;
const ENABLED = Boolean(SMOKE_URL && SMOKE_TOKEN);

const enabled = ENABLED ? it : it.skip;

if (!ENABLED) {
  it("smoke suite skipped: set GITLAB_MCP_SMOKE_URL and GITLAB_MCP_SMOKE_TOKEN to run against a real GitLab", () => {
    expect(ENABLED).toBe(false);
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.resolve(here, "../../dist/index.js");

let child: ReturnType<typeof spawn> | undefined;
let mcpUrl = "";

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`gitlab-mcp did not become healthy within ${timeoutMs}ms`);
}

function rpc(method: string, params: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function post(body: string): Promise<any> {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-GitLab-URL": SMOKE_URL as string,
      "X-GitLab-Token": SMOKE_TOKEN as string,
    },
    body,
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  // Plain JSON or SSE frames.
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }) {
  return {
    text: result.content?.[0]?.text ?? "",
    isError: result.isError === true,
  };
}

beforeAll(async () => {
  if (!ENABLED) return;
  const port = await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
  child = spawn(process.execPath, [serverJs], {
    env: {
      ...process.env,
      GITLAB_MCP_PORT: String(port),
      // Allowlist must include the real GitLab host (SSRF guard).
      GITLAB_MCP_ALLOWED_HOSTS: new URL(SMOKE_URL as string).host,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
  await waitForHealth(new URL(mcpUrl).origin);
});

afterAll(() => {
  child?.kill("SIGTERM");
});

describe("smoke against real GitLab (read-only)", () => {
  enabled("server responds to initialize", async () => {
    const body = await post(
      rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "gitlabmcp-smoke", version: "0.1.0" },
      }),
    );
    expect(body.result?.serverInfo?.name).toBeTruthy();
  });

  enabled("tools/list includes read-only tools", async () => {
    const body = await post(rpc("tools/list", {}));
    const names: string[] = (body.result?.tools ?? []).map(
      (t: { name: string }) => t.name,
    );
    expect(names).toContain("gitlab_system_current_user");
    expect(names).toContain("gitlab_project_list");
  });

  enabled("gitlab_system_current_user returns real identity", async () => {
    const body = await post(
      rpc("tools/call", {
        name: "gitlab_system_current_user",
        arguments: {},
      }),
    );
    const { text, isError } = textOf(body.result);
    expect(isError).toBe(false);
    const identity = JSON.parse(text);
    expect(identity.username).toBeTruthy();
  });

  enabled("gitlab_project_list returns projects", async () => {
    const body = await post(
      rpc("tools/call", {
        name: "gitlab_project_list",
        arguments: { limit: 5 },
      }),
    );
    const { text, isError } = textOf(body.result);
    expect(isError).toBe(false);
    const projects = JSON.parse(text);
    expect(Array.isArray(projects)).toBe(true);
  });
});
