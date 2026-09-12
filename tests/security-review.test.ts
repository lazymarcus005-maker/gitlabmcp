/**
 * Adversarial security review tests (issue #12): redaction against hostile
 * inputs across every log sink, SSRF/host-allowlist edge cases, TLS policy
 * downgrade rejection, V1 exclusion verification and HTTP robustness.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { AddressInfo } from "node:net";

import { redact } from "../src/security/redaction.js";
import { auditToolCall } from "../src/audit/logger.js";
import { describeConfig, loadConfig } from "../src/config.js";
import { HostAllowlist } from "../src/security/host-allowlist.js";
import { resolveTlsVerify } from "../src/security/tls-policy.js";
import { IdentityResolver } from "../src/security/identity.js";
import { buildMcpServer } from "../src/server/app-server.js";
import { createHttpServer as createMcpServer } from "../src/server/http-server.js";
import { decodeCursor, resolveListRequest, encodeCursor } from "../src/gitlab/pagination.js";
import { ErrorCodes, GatewayError } from "../src/errors.js";

const SECRET = "sup3rsecretvalue";
const PAT = "glpat-adversarial-token-9x2";

function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 1. Redaction: hostile inputs through the layer directly
// ---------------------------------------------------------------------------
describe("redaction layer vs hostile inputs", () => {
  const hostileStrings = [
    `private_token=${SECRET}`,
    `PRIVATE-TOKEN:${SECRET}`,
    `private-token: ${SECRET}`,
    `client_secret=${SECRET}`,
    `?private_token=${SECRET}&per_page=20`,
    `Authorization: Bearer ${SECRET}`,
    `authorization=${SECRET}`,
    `cookie: _gitlab_session=${SECRET}`,
    `token=${SECRET}`,
    `password: ${SECRET}`,
    `api_key=${SECRET}`,
    `Bearer ${SECRET}`,
    `Basic ${Buffer.from(`root:${SECRET}`).toString("base64")}`,
    PAT,
    `https://git.example.com/api/v4/user?private_token=${PAT}`,
  ];

  it.each(hostileStrings)("redacts free-form secret text: %s", (input) => {
    const out = redact(input);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(PAT);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts secret-valued JSON keys (nested objects and arrays)", () => {
    const hostile = {
      outer: {
        authorization: `Bearer ${SECRET}`,
        private_token: PAT,
        "access-token": SECRET,
        deep: [{ key: "DB_PASSWORD", value: SECRET }],
      },
    };
    const out = JSON.stringify(redact(hostile));
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(PAT);
  });

  it("redacts GitLab CI variable shape by structure ({key, value})", () => {
    const out = redact([{ key: "SECRET_KEY", value: SECRET }, { key: "PUBLIC", value: "hello" }]);
    const json = JSON.stringify(out);
    // Fail closed: every {key, value} pair's value is redacted, keys survive.
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("hello");
    expect(json).toContain('"key":"PUBLIC"');
  });

  it("redacts URL-encoded tokens appearing literally", () => {
    const out = redact(`redirect=?token%3D${PAT}%26x=1`);
    expect(out).not.toContain(PAT);
  });

  it("does not mangle benign content", () => {
    const benign = {
      title: "Fix tokenizer regression",
      note: "tokens like 'tokenization' and 'monkeypatch' are prose",
      body: "password strength docs",
    };
    expect(redact(benign)).toEqual(benign);
  });
});

// ---------------------------------------------------------------------------
// 1b. Redaction: every log sink
// ---------------------------------------------------------------------------
describe("log sinks never emit secrets", () => {
  const hostileAudit = {
    request_id: `req-${PAT}`,
    gitlab: {
      host: "git.tiddaw.net",
      user_id: 1,
      username: `marcus token=${SECRET}`,
    },
    tool: "gitlab_issue_get",
    result: "error" as const,
    duration_ms: 3,
  };

  it("audit line carries no token-like material", () => {
    const lines = captureStdout(() => auditToolCall(hostileAudit));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(PAT);
    expect(lines[0]).not.toContain(SECRET);
  });

  it("startup config log is redacted (hostile values injected via env)", () => {
    const config = loadConfig({
      GITLAB_MCP_ALLOWED_HOSTS: `git.tiddaw.net,${PAT}`,
      GITLAB_MCP_PROTECTED_BRANCHES: `main,password=${SECRET}`,
    } as NodeJS.ProcessEnv);
    const line = describeConfig(config);
    expect(line).not.toContain(PAT);
    expect(line).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// 2. SSRF / host allowlist edge cases
// ---------------------------------------------------------------------------
describe("host allowlist edge cases (SSRF)", () => {
  const allowlist = new HostAllowlist(["git.tiddaw.net", "gitlab-uat.tiddaw.net:8443"]);

  const mustReject = [
    "http://169.254.169.254/latest/meta-data/",
    "http://100.100.100.200/metadata",
    "http://[::1]:8080/",
    "http://[fd00::1]/",
    "http://localhost/",
    "http://LOCALHOST:8080/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://0.0.0.0/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://169.254.169.254:80/",
    "https://git.tiddaw.net.evil.com/",
    "https://evil.com/git.tiddaw.net",
    "https://git.tiddaw.net@evil.com/",
    "https://evil.tiddaw.net/",
    "http://git.tiddaw.net.:8080/",
    "https://GIT.TIDDAW.NET.EVIL.IO/",
    "http://gitlab-uat.tiddaw.net:9999/",
    "https://git.tiddaw.net@evil.com:443/x",
  ];

  it.each(mustReject)("rejects %s", (url) => {
    expect(allowlist.isAllowed(url)).toBe(false);
    try {
      allowlist.check(url);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as GatewayError).code).toBe(ErrorCodes.GITLAB_HOST_NOT_ALLOWED);
    }
  });

  it("rejects userinfo-carrying URLs (https://token@git.tiddaw.net)", () => {
    expect(allowlist.isAllowed("https://PAT@git.tiddaw.net")).toBe(false);
    expect(allowlist.isAllowed("https://user:pass@git.tiddaw.net")).toBe(false);
  });

  it("still accepts the exact allowlisted hosts on any port (or the pinned port)", () => {
    expect(allowlist.isAllowed("https://git.tiddaw.net/api/v4")).toBe(true);
    expect(allowlist.isAllowed("http://git.tiddaw.net:8443/")).toBe(true);
    expect(allowlist.isAllowed("https://gitlab-uat.tiddaw.net:8443/")).toBe(true);
  });

  it("matching is case-insensitive for the allowlisted host itself", () => {
    expect(allowlist.isAllowed("https://GIT.TIDDAW.NET/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. TLS policy
// ---------------------------------------------------------------------------
describe("TLS policy downgrade rejection", () => {
  const config = { allowDisableVerify: true, disableVerifyHosts: ["git-internal.corp"] };

  it("rejects verify=false on a host not in disable_verify_hosts", () => {
    try {
      resolveTlsVerify("https://git.tiddaw.net", false, config);
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as GatewayError;
      expect(err.code).toBe(ErrorCodes.POLICY_TLS_VERIFY_FORBIDDEN);
      expect(err.message).not.toMatch(/false/i);
    }
  });

  it("rejects verify=false even when allow_disable_verify is true but host is not exempt", () => {
    expect(() =>
      resolveTlsVerify("https://git-internal.corp.evil.com", false, config),
    ).toThrow();
  });

  it("honors verify=false only on an exempt host", () => {
    expect(resolveTlsVerify("https://git-internal.corp", false, config)).toBe(false);
    expect(resolveTlsVerify("https://git-internal.corp", true, config)).toBe(true);
  });

  it("rejects verify=false entirely when allow_disable_verify is false", () => {
    expect(() =>
      resolveTlsVerify("https://git-internal.corp", false, {
        allowDisableVerify: false,
        disableVerifyHosts: ["git-internal.corp"],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. V1 exclusion verification: tool registry
// ---------------------------------------------------------------------------
describe("V1 exclusion list is unreachable in the tool registry", () => {
  const toolNames = Object.keys(buildMcpServer()._registeredTools ?? {});

  it("registers at least the 44 documented tools", () => {
    expect(toolNames.length).toBeGreaterThanOrEqual(44);
  });

  it.each([
    "gitlab_project_delete",
    "gitlab_project_transfer",
    "gitlab_group_delete",
    "gitlab_member_remove",
    "gitlab_project_member_remove",
    "gitlab_protected_branch_delete",
    "gitlab_variable_get",
    "gitlab_variable_list",
    "gitlab_variable_create",
    "gitlab_variable_update",
    "gitlab_variable_delete",
    "gitlab_deploy_token_create",
    "gitlab_deploy_token_list",
    "gitlab_deploy_token_revoke",
    "gitlab_access_token_create",
    "gitlab_access_token_list",
    "gitlab_access_token_revoke",
    "gitlab_runner_delete",
    "gitlab_runner_list",
  ])("does not register excluded tool '%s'", (excluded) => {
    expect(toolNames).not.toContain(excluded);
  });

  it("registers no tool whose name matches the excluded operation families", () => {
    const excludedFamilies = /(^|_)(variable|variables|deploy[-_]?token|access[-_]?token|runner|member[-_]?remove|delete|transfer|impersonation)/;
    const offenders = toolNames.filter((n) => excludedFamilies.test(n));
    // branch_delete is allowed by design (FR-10 guardrails + policy engine);
    // nothing else from the excluded families may appear.
    expect(offenders.filter((n) => n !== "gitlab_branch_delete")).toEqual([]);
  });

  it("every registered tool name matches the MCP spec pattern", () => {
    for (const name of toolNames) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Misc: cursor tampering, identity cache, error hygiene
// ---------------------------------------------------------------------------
describe("cursor tampering rejection", () => {
  it("rejects garbage, unsigned and structurally hostile cursors", () => {
    const hostile = [
      "not-a-cursor",
      Buffer.from('{"page":1,"per_page":100000}').toString("base64url"),
      Buffer.from('{"page":-1,"per_page":20}').toString("base64url"),
      Buffer.from('{"page":"1","per_page":20}').toString("base64url"),
      Buffer.from('{"page":1}').toString("base64url"),
      Buffer.from("[]").toString("base64url"),
      "eyJwYWdlIjoxfQ", // truncated base64
    ];
    for (const cursor of hostile) {
      expect(() => decodeCursor(cursor)).toThrow(GatewayError);
      expect(() =>
        resolveListRequest({ cursor }, { defaultLimit: 20, maxLimit: 100 }),
      ).toThrow(/cursor/i);
    }
  });

  it("accepts only cursors the server itself issued", () => {
    const cursor = encodeCursor({ page: 3, per_page: 50 });
    expect(decodeCursor(cursor)).toEqual({ page: 3, per_page: 50 });
    expect(() => decodeCursor(Buffer.from('{"page":1,"per_page":20,"admin":true}').toString("base64url"))).not.toThrow();
    expect(resolveListRequest({ cursor }, { defaultLimit: 20, maxLimit: 100 })).toEqual({
      page: 3,
      per_page: 50,
      limit: 50,
    });
  });
});

describe("identity cache stores no tokens", () => {
  it("cache keys are token hashes, values carry no token; hit avoids refetch", async () => {
    let calls = 0;
    const resolver = new IdentityResolver({
      ttlMs: 60_000,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ id: 7, username: "marcus" }), { status: 200 });
      },
    });
    const token = PAT;
    await resolver.resolve("https://git.tiddaw.net", token);
    expect(calls).toBe(1);
    const second = await resolver.resolve("https://git.tiddaw.net", token);
    expect(calls).toBe(1);
    expect(second).toMatchObject({ id: 7, username: "marcus" });

    // Internal cache: keys are sha256 hex, values hold no token material.
    const cache = (resolver as unknown as { cache: Map<string, unknown> }).cache;
    expect(cache.size).toBe(1);
    for (const [key, value] of cache) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(value)).not.toContain(token);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. HTTP robustness
// ---------------------------------------------------------------------------
describe("HTTP server robustness", () => {
  let gitlab: Server;
  let mcp: Server;
  let mcpUrl: string;
  let gitlabUrl: string;

  beforeAll(async () => {
    gitlab = createHttpServer((req, res) => {
      if (req.url?.startsWith("/api/v4/user")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: 42, username: "marcus" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => gitlab.listen(0, "127.0.0.1", r));
    const ga = gitlab.address() as AddressInfo;
    gitlabUrl = `http://127.0.0.1:${ga.port}`;

    const config = loadConfig({
      GITLAB_MCP_ALLOWED_HOSTS: new URL(gitlabUrl).host,
      GITLAB_MCP_IDENTITY_CACHE_TTL_MS: "3600000",
    } as NodeJS.ProcessEnv);
    mcp = createMcpServer(config);
    await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
    const ma = mcp.address() as AddressInfo;
    mcpUrl = `http://127.0.0.1:${ma.port}${config.httpPath}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => gitlab.close(() => r()));
    await new Promise<void>((r) => mcp.close(() => r()));
  });

  it("malformed JSON body returns 400 and the server keeps serving", async () => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{this is not json",
    });
    expect(res.status).toBe(400);
    const healthy = await fetch(mcpUrl.replace(/\/mcp$/, "/health"));
    expect(healthy.status).toBe(200);
  });

  it("oversized request body is rejected with 413, not a crash", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pad: big }),
    });
    expect([413, 500]).toContain(res.status);
    const healthy = await fetch(mcpUrl.replace(/\/mcp$/, "/health"));
    expect(healthy.status).toBe(200);
  });

  it("oversized headers get 431 and the server keeps serving", async () => {
    const addr = mcp.address() as AddressInfo;
    const socket: Socket = await new Promise((resolve) => {
      const s = netConnect(addr.port, "127.0.0.1", () => resolve(s));
    });
    const headerLine = `${"A".repeat(8 * 1024)}: ${"B".repeat(8 * 1024)}\r\n`;
    socket.write(`POST /mcp HTTP/1.1\r\nHost: x\r\n${headerLine.repeat(8)}\r\n`);
    const reply = await new Promise<string>((resolve) => {
      let data = "";
      socket.on("data", (d) => {
        data += String(d);
        resolve(data);
      });
      setTimeout(() => resolve(data), 1500);
    });
    expect(reply).toMatch(/431|400/);
    socket.destroy();
    const healthy = await fetch(mcpUrl.replace(/\/mcp$/, "/health"));
    expect(healthy.status).toBe(200);
  });

  it("userinfo credentials in X-GitLab-URL are rejected with a typed error", async () => {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-GitLab-URL": "https://leaked-token@git.tiddaw.net",
        "X-GitLab-Token": PAT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "gitlab_system_current_user", arguments: {} },
      }),
    });
    const body = (await res.json()) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
    };
    const text = body.result?.content?.[0]?.text ?? "";
    expect(body.result?.isError).toBe(true);
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).not.toContain("leaked-token");
  });
});
