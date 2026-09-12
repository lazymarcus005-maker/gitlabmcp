import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createGitLabClient } from "../src/gitlab/client-factory.js";
import { buildListResponse, resolveListRequest } from "../src/gitlab/pagination.js";
import { logCapabilityOnce, resetCapabilityLog } from "../src/gitlab/capability.js";
import { ErrorCodes, GatewayError } from "../src/errors.js";
import type { GitLabRequestContext } from "../src/context/request-context.js";

let gitlab: Server;
let baseUrl: string;
let lastPageQuery = "";
const responder = new Map<string, (url: string) => Record<string, string>>();

beforeAll(async () => {
  gitlab = createServer((req, res) => {
    const url = req.url ?? "";
    lastPageQuery = url;
    const headers = responder.get(url.split("?")[0] ?? "")?.(url) ?? {};
    res.writeHead(200, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => gitlab.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(gitlab.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => gitlab.close(() => r()));
});

function makeCtx(baseUrlOverride?: string): GitLabRequestContext {
  return {
    requestId: "test",
    gitlab: { baseUrl: baseUrlOverride ?? baseUrl, token: "glpat-test", tls: { verify: true } },
    identity: { id: 1, username: "tester" },
  };
}

async function listen(port0: unknown, handler: (req: unknown, res: unknown) => void): Promise<[Server, string]> {
  void port0;
  const server = createServer(handler as never);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return [server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`];
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((r) => server.close(() => r()));
}

async function expectErrorCode(promise: Promise<unknown>, code: string, messagePart?: string) {
  try {
    await promise;
    expect.fail("should throw");
  } catch (e) {
    expect(e).toBeInstanceOf(GatewayError);
    expect((e as GatewayError).code).toBe(code);
    if (messagePart) expect((e as GatewayError).message).toContain(messagePart);
  }
}

describe("error mapping (FR-14/FR-15)", () => {
  it("maps a GitLab 500 to GITLAB_API_ERROR including status and message", async () => {
    const [server, url] = await listen(null, (_req, res) => {
      (res as { writeHead: (...a: unknown[]) => void; end: (b: string) => void }).writeHead(
        500,
        { "Content-Type": "application/json" },
      );
      (res as { end: (b: string) => void }).end(
        JSON.stringify({ message: "500 Internal Server Error - boom" }),
      );
    });
    const client = createGitLabClient(makeCtx(url));
    await expectErrorCode(
      client.getJson("/api/v4/projects"),
      ErrorCodes.GITLAB_API_ERROR,
      "HTTP 500",
    );
    await expectErrorCode(client.getJson("/api/v4/projects"), ErrorCodes.GITLAB_API_ERROR, "boom");
    await close(server);
  });

  it("maps 429 to GITLAB_RATE_LIMITED (no auto-retry)", async () => {
    let hits = 0;
    const [server, url] = await listen(null, (_req, res) => {
      hits += 1;
      (res as { writeHead: (...a: unknown[]) => void; end: (b: string) => void }).writeHead(
        429,
        { "Content-Type": "application/json" },
      );
      (res as { end: (b: string) => void }).end(
        JSON.stringify({ message: "Rate limit exceeded" }),
      );
    });
    const client = createGitLabClient(makeCtx(url));
    await expectErrorCode(
      client.getJson("/api/v4/projects"),
      ErrorCodes.GITLAB_RATE_LIMITED,
      "429",
    );
    // Exactly one outbound attempt: surfaced, not retried.
    expect(hits).toBe(1);
    await close(server);
  });

  it("maps an exceeded default timeout to GITLAB_TIMEOUT", async () => {
    const [server, url] = await listen(null, (_req, res) => {
      setTimeout(() => {
        (res as { writeHead: (...a: unknown[]) => void; end: (b: string) => void }).writeHead(200, {
          "Content-Type": "application/json",
        });
        (res as { end: (b: string) => void }).end("{}");
      }, 500);
    });
    const client = createGitLabClient(makeCtx(url), { timeoutMs: 50 });
    await expectErrorCode(
      client.getJson("/api/v4/slow"),
      ErrorCodes.GITLAB_TIMEOUT,
      "50ms",
    );
    await close(server);
  });

  it("honours the per-call timeout override (60s job paths)", async () => {
    const [server, url] = await listen(null, (_req, res) => {
      setTimeout(() => {
        (res as { writeHead: (...a: unknown[]) => void; end: (b: string) => void }).writeHead(200, {
          "Content-Type": "application/json",
        });
        (res as { end: (b: string) => void }).end('{"ok":true}');
      }, 400);
    });
    // Client default of 50ms would abort; the per-call override is generous.
    const client = createGitLabClient(makeCtx(url), { timeoutMs: 50 });
    const started = Date.now();
    const data = await client.getJson<{ ok: boolean }>("/api/v4/slow", { timeoutMs: 5000 });
    expect(data.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    await close(server);
  });
});

describe("list pagination against mock GitLab (FR-12)", () => {
  it("translates {limit, cursor} to page/per_page and shapes the response", async () => {
    responder.set("/api/v4/projects", (url) => {
      const page = new URL(url, "http://x").searchParams.get("page");
      return page === "1" ? { "x-next-page": "2" } : { "x-next-page": "" };
    });
    const client = createGitLabClient(makeCtx());
    const limits = { defaultLimit: 20, maxLimit: 100 };

    const first = resolveListRequest({ limit: 5 }, limits);
    const firstRes = await client.getWithHeaders<unknown[]>(
      `/api/v4/projects?page=${first.page}&per_page=${first.per_page}`,
    );
    expect(lastPageQuery).toContain("page=1&per_page=5");
    const firstPage = buildListResponse([1, 2, 3, 4, 5], first, firstRes.headers);
    expect(firstPage.pagination.has_more).toBe(true);
    expect(firstPage.pagination.next_cursor).toBeTruthy();
    // GitLab paging internals are never exposed.
    expect(JSON.stringify(firstPage)).not.toContain("x-next-page");

    const second = resolveListRequest({ cursor: firstPage.pagination.next_cursor! }, limits);
    expect(second.page).toBe(2);
    expect(second.per_page).toBe(5);
    const secondRes = await client.getWithHeaders<unknown[]>(
      `/api/v4/projects?page=${second.page}&per_page=${second.per_page}`,
    );
    const secondPage = buildListResponse([], second, secondRes.headers);
    expect(secondPage.pagination).toEqual({ has_more: false, next_cursor: null });
  });
});

describe("capability check (FR-16)", () => {
  it("logs the GitLab version once", async () => {
    const [server, url] = await listen(null, (_req, res) => {
      (res as { writeHead: (...a: unknown[]) => void; end: (b: string) => void }).writeHead(200, {
        "Content-Type": "application/json",
      });
      (res as { end: (b: string) => void }).end(
        JSON.stringify({ version: "18.8.3-ee", revision: "abc" }),
      );
    });
    const client = createGitLabClient(makeCtx(url));

    resetCapabilityLog();
    const lines: string[] = [];
    await logCapabilityOnce(client, (l) => lines.push(l));
    await logCapabilityOnce(client, (l) => lines.push(l));
    await logCapabilityOnce(client, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      msg: "gitlab capability check",
      version: "18.8.3-ee",
    });
    await close(server);
  });

  it("logs a warning and continues when the version endpoint fails", async () => {
    const [server, url] = await listen(null, (_req, res) => {
      (res as { writeHead: (...a: unknown[]) => void; end: (b: string) => void }).writeHead(500, {
        "Content-Type": "application/json",
      });
      (res as { end: (b: string) => void }).end(JSON.stringify({ message: "nope" }));
    });
    const client = createGitLabClient(makeCtx(url));

    resetCapabilityLog();
    const lines: string[] = [];
    await logCapabilityOnce(client, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toContain("failed");
    await close(server);
  });
});
