/**
 * Contract tests for the pipeline + job domain tools (issue #9, tool-spec
 * §Pipeline & Job): full stack per call — gateway → policy engine → GitLab
 * client → handler — against a mock GitLab HTTP server. Covers WRITE tools
 * requiring `pipeline-write` (read scope → POLICY_SCOPE_MISSING), trace
 * truncation with the offset continuation (FR-13), the 60 s job timeout
 * wiring (FR-14), pagination and default-project fallback.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildMcpServer } from "../src/server/app-server.js";
import { IdentityResolver } from "../src/security/identity.js";
import { HostAllowlist } from "../src/security/host-allowlist.js";
import { loadConfig } from "../src/config.js";
import { runWithRequestScope, type RequestScope } from "../src/context/request-scope.js";
import { resetCapabilityLog } from "../src/gitlab/capability.js";

const TOKEN = "glpat-pipeline-tools-test";
const IDENTITY = { id: 42, username: "marcus", name: "Marcus Y" };

const PIPELINES = [
  { id: 101, status: "success", ref: "main" },
  { id: 102, status: "failed", ref: "feature/one" },
  { id: 103, status: "running", ref: "main" },
];

const JOBS = [
  { id: 501, name: "build", stage: "build", status: "success" },
  { id: 502, name: "test", stage: "test", status: "failed" },
];

// Trace long enough to exceed a small test cap.
const TRACE = "a".repeat(300) + "b".repeat(300) + "END-OF-TRACE";

let gitlab: Server;
let gitlabUrl: string;

/** Trace/job delays (ms) to exercise the job timeout wiring; keyed by path. */
const delays: Record<string, number> = {};

/** Recorded GitLab requests: method, decoded path, query, parsed JSON body. */
const calls: Array<{
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}> = [];

function slicePage(all: unknown[], url: URL): { data: unknown[]; nextPage: string } {
  const page = Number(url.searchParams.get("page") ?? "1");
  const perPage = Number(url.searchParams.get("per_page") ?? "20");
  const start = (page - 1) * perPage;
  const data = all.slice(start, start + perPage);
  const nextPage = start + perPage < all.length ? String(page + 1) : "";
  return { data, nextPage };
}

beforeAll(async () => {
  gitlab = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", async () => {
      const body = raw !== "" ? JSON.parse(raw) : undefined;
      if (path !== "/api/v4/user" && path !== "/api/v4/version") {
        calls.push({
          method: req.method ?? "GET",
          path,
          query: Object.fromEntries(url.searchParams),
          body,
        });
      }
      if (path === "/api/v4/user") return json(200, IDENTITY);
      if (path === "/api/v4/version") {
        return json(200, { version: "18.8.3-ee", revision: "abc123" });
      }
      if (delays[path]) {
        await new Promise((r) => setTimeout(r, delays[path]));
      }
      // Pipeline list: /api/v4/projects/:id/pipelines
      if (path === "/api/v4/projects/itrend/cxutility/pipelines") {
        let rows = PIPELINES;
        const ref = url.searchParams.get("ref");
        if (ref) rows = rows.filter((p) => p.ref === ref);
        const status = url.searchParams.get("status");
        if (status) rows = rows.filter((p) => p.status === status);
        const { data, nextPage } = slicePage(rows, url);
        return json(200, data, { "x-next-page": nextPage, "x-total": String(rows.length) });
      }
      // Pipeline detail / retry / cancel: /pipelines/:id[/retry|/cancel]
      const plMatch = path.match(/^\/api\/v4\/projects\/itrend\/cxutility\/pipelines\/(\d+)(\/(retry|cancel))?$/);
      if (plMatch) {
        const id = Number(plMatch[1]);
        const pipeline = PIPELINES.find((p) => p.id === id);
        if (!pipeline) return json(404, { message: "404 Pipeline Not Found" });
        if (plMatch[3] === "retry") return json(201, { ...pipeline, status: "pending" });
        if (plMatch[3] === "cancel") return json(200, { ...pipeline, status: "canceled" });
        return json(200, pipeline);
      }
      // Jobs of a pipeline: /pipelines/:id/jobs
      const plJobsMatch = path.match(/^\/api\/v4\/projects\/itrend\/cxutility\/pipelines\/(\d+)\/jobs$/);
      if (plJobsMatch) {
        const id = Number(plJobsMatch[1]);
        if (!PIPELINES.some((p) => p.id === id)) {
          return json(404, { message: "404 Pipeline Not Found" });
        }
        return json(200, JOBS);
      }
      // Job detail: /jobs/:id
      const jobMatch = path.match(/^\/api\/v4\/projects\/itrend\/cxutility\/jobs\/(\d+)$/);
      if (jobMatch) {
        const job = JOBS.find((j) => j.id === Number(jobMatch[1]));
        if (!job) return json(404, { message: "404 Job Not Found" });
        return json(200, job);
      }
      // Job trace: raw text, not JSON.
      const traceMatch = path.match(/^\/api\/v4\/projects\/itrend\/cxutility\/jobs\/(\d+)\/trace$/);
      if (traceMatch) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(TRACE);
        return;
      }
      return json(404, { message: "404 Not Found" });
    });
  });
  await new Promise<void>((r) => gitlab.listen(0, "127.0.0.1", r));
  const ga = gitlab.address() as AddressInfo;
  gitlabUrl = `http://127.0.0.1:${ga.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => gitlab.close(() => r()));
});

function buildScope(
  headerEnv: Record<string, string>,
  configEnv: Record<string, string> = {},
): RequestScope {
  return {
    headers: {
      "x-gitlab-url": gitlabUrl,
      "x-gitlab-token": TOKEN,
      ...headerEnv,
    },
    config: loadConfig({
      GITLAB_MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
      GITLAB_MCP_IDENTITY_CACHE_TTL_MS: "3600000",
      ...configEnv,
    } as NodeJS.ProcessEnv),
    identityResolver: new IdentityResolver({
      ttlMs: 3_600_000,
      fetchImpl: async () =>
        new Response(JSON.stringify(IDENTITY), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    }),
    allowlist: new HostAllowlist(["127.0.0.1", "localhost"]),
  };
}

async function callTool(
  scope: RequestScope,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const server: McpServer = buildMcpServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await runWithRequestScope(scope, async () => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: Array<{ text?: string }>;
      };
      return {
        text: result.content[0]?.text ?? "",
        isError: result.isError === true,
      };
    });
  } finally {
    await client.close();
    await server.close();
  }
}

beforeAll(() => {
  resetCapabilityLog();
});

describe("gitlab_pipeline_list", () => {
  it("lists pipelines with the pagination contract", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_pipeline_list",
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items).toHaveLength(3);
    expect(body.pagination).toEqual({ has_more: false, next_cursor: null });
  });

  it("paginates via opaque cursors", async () => {
    const scope = buildScope({ "x-gitlab-default-project": "itrend/cxutility" });
    const first = await callTool(scope, "gitlab_pipeline_list", { limit: 2 });
    const firstBody = JSON.parse(first.text);
    expect(firstBody.items.map((p: { id: number }) => p.id)).toEqual([101, 102]);
    expect(firstBody.pagination.has_more).toBe(true);

    const second = await callTool(scope, "gitlab_pipeline_list", {
      cursor: firstBody.pagination.next_cursor,
    });
    const secondBody = JSON.parse(second.text);
    expect(secondBody.items.map((p: { id: number }) => p.id)).toEqual([103]);
    expect(secondBody.pagination).toEqual({ has_more: false, next_cursor: null });
  });

  it("sends ref and status filters as query params", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_pipeline_list",
      { ref: "main", status: "running" },
    );
    expect(result.isError).toBe(false);
    const last = calls[calls.length - 1];
    expect(last.method).toBe("GET");
    expect(last.path).toBe("/api/v4/projects/itrend/cxutility/pipelines");
    expect(last.query.ref).toBe("main");
    expect(last.query.status).toBe("running");
    expect(JSON.parse(result.text).items.map((p: { id: number }) => p.id)).toEqual([103]);
  });

  it("project outside Project Scope → SCOPE_PROJECT_NOT_ALLOWED", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-project-scope": "itrend/*" }),
      "gitlab_pipeline_list",
      { project: "other/thing" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR SCOPE_PROJECT_NOT_ALLOWED: /);
  });
});

describe("gitlab_pipeline_get", () => {
  it("returns a single pipeline by id, URL-encoding the project path", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_pipeline_get",
      { project: "itrend/cxutility", pipeline_id: 102 },
    );
    expect(result.isError).toBe(false);
    const pipeline = JSON.parse(result.text);
    expect(pipeline.id).toBe(102);
    expect(pipeline.status).toBe("failed");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("GET");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/pipelines/102");
  });

  it("falls back to the X-GitLab-Default-Project header when project is omitted", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_pipeline_get",
      { pipeline_id: 101 },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).id).toBe(101);
  });

  it("missing project without default header → VALIDATION_ERROR", async () => {
    const result = await callTool(buildScope({}), "gitlab_pipeline_get", { pipeline_id: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: missing required argument 'project'/);
  });

  it("non-integer pipeline_id → VALIDATION_ERROR", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-default-project": "itrend/cxutility" }),
      "gitlab_pipeline_get",
      { pipeline_id: -1 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: missing required argument 'pipeline_id'/);
  });
});

describe("gitlab_pipeline_retry / gitlab_pipeline_cancel", () => {
  it("retries via POST to /pipelines/:id/retry", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_pipeline_retry",
      { project: "itrend/cxutility", pipeline_id: 102 },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).status).toBe("pending");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/pipelines/102/retry");
    expect(call.body).toEqual({});
  });

  it("cancels via POST to /pipelines/:id/cancel", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_pipeline_cancel",
      { project: "itrend/cxutility", pipeline_id: 103 },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).status).toBe("canceled");
    const call = calls[calls.length - 1];
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v4/projects/itrend/cxutility/pipelines/103/cancel");
  });

  it("retry without pipeline-write scope → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "read" }),
      "gitlab_pipeline_retry",
      { project: "itrend/cxutility", pipeline_id: 102 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: .*pipeline-write/);
  });

  it("cancel without pipeline-write scope → POLICY_SCOPE_MISSING", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "issue-write" }),
      "gitlab_pipeline_cancel",
      { project: "itrend/cxutility", pipeline_id: 103 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR POLICY_SCOPE_MISSING: .*pipeline-write/);
  });

  it("retry with pipeline-write scope succeeds", async () => {
    const result = await callTool(
      buildScope({ "x-gitlab-request-scope": "pipeline-write" }),
      "gitlab_pipeline_retry",
      { project: "itrend/cxutility", pipeline_id: 102 },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).status).toBe("pending");
  });
});

describe("gitlab_job_list / gitlab_job_get", () => {
  it("lists the jobs of a pipeline", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_job_list",
      { project: "itrend/cxutility", pipeline_id: 101 },
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.items.map((j: { id: number }) => j.id)).toEqual([501, 502]);
    expect(calls[calls.length - 1].path).toBe(
      "/api/v4/projects/itrend/cxutility/pipelines/101/jobs",
    );
  });

  it("returns a single job by id", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_job_get",
      { project: "itrend/cxutility", job_id: 502 },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).name).toBe("test");
    expect(calls[calls.length - 1].path).toBe("/api/v4/projects/itrend/cxutility/jobs/502");
  });

  it("uses the job timeout (GITLAB_MCP_JOB_TIMEOUT_MS) for job.list", async () => {
    delays["/api/v4/projects/itrend/cxutility/pipelines/101/jobs"] = 300;
    try {
      const result = await callTool(
        buildScope({}, { GITLAB_MCP_JOB_TIMEOUT_MS: "100" }),
        "gitlab_job_list",
        { project: "itrend/cxutility", pipeline_id: 101 },
      );
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^ERROR GITLAB_TIMEOUT: .*timed out after 100ms/);
    } finally {
      delete delays["/api/v4/projects/itrend/cxutility/pipelines/101/jobs"];
    }
  });

  it("uses the job timeout (GITLAB_MCP_JOB_TIMEOUT_MS) for job.get", async () => {
    delays["/api/v4/projects/itrend/cxutility/jobs/501"] = 300;
    try {
      const result = await callTool(
        buildScope({}, { GITLAB_MCP_JOB_TIMEOUT_MS: "100" }),
        "gitlab_job_get",
        { project: "itrend/cxutility", job_id: 501 },
      );
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^ERROR GITLAB_TIMEOUT: .*timed out after 100ms/);
    } finally {
      delete delays["/api/v4/projects/itrend/cxutility/jobs/501"];
    }
  });
});

describe("gitlab_job_trace", () => {
  it("returns a short trace untruncated with next_offset null", async () => {
    calls.length = 0;
    const result = await callTool(
      buildScope({}),
      "gitlab_job_trace",
      { project: "itrend/cxutility", job_id: 501 },
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text);
    expect(body.truncated).toBe(false);
    expect(body.content).toBe(TRACE);
    expect(body.offset).toBe(0);
    expect(body.next_offset).toBeNull();
    expect(body.total_bytes).toBe(Buffer.byteLength(TRACE, "utf8"));
    expect(calls[calls.length - 1].path).toBe(
      "/api/v4/projects/itrend/cxutility/jobs/501/trace",
    );
  });

  it("truncates the window and continues via the offset arithmetic", async () => {
    const scope = buildScope({}, { GITLAB_MCP_MAX_BYTES: "512" });
    const first = await callTool(scope, "gitlab_job_trace", {
      project: "itrend/cxutility",
      job_id: 501,
    });
    expect(first.isError).toBe(false);
    const firstBody = JSON.parse(first.text);
    expect(firstBody.truncated).toBe(true);
    expect(firstBody.original_bytes).toBe(Buffer.byteLength(TRACE, "utf8"));
    expect(Buffer.byteLength(firstBody.content, "utf8")).toBeLessThanOrEqual(512);
    expect(firstBody.content).toBe(TRACE.slice(0, 512));
    expect(firstBody.continuation_hint).toMatch(/offset/);

    // next offset = offset + bytes returned, resuming exactly where the
    // returned window ends.
    const expectedNext =
      firstBody.offset + Buffer.byteLength(firstBody.content, "utf8");
    expect(firstBody.next_offset).toBe(expectedNext);

    const second = await callTool(scope, "gitlab_job_trace", {
      project: "itrend/cxutility",
      job_id: 501,
      offset: firstBody.next_offset,
    });
    const secondBody = JSON.parse(second.text);
    expect(secondBody.offset).toBe(expectedNext);
    expect(secondBody.truncated).toBe(false);
    expect(secondBody.next_offset).toBeNull();
    // The second window resumes exactly where the first truncation happened.
    expect(secondBody.content).toBe(TRACE.slice(firstBody.next_offset));
  });

  it("negative offset → VALIDATION_ERROR", async () => {
    const result = await callTool(
      buildScope({}),
      "gitlab_job_trace",
      { project: "itrend/cxutility", job_id: 501, offset: -5 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ERROR VALIDATION_ERROR: argument 'offset'/);
  });

  it("uses the job timeout (GITLAB_MCP_JOB_TIMEOUT_MS)", async () => {
    const tracePath = "/api/v4/projects/itrend/cxutility/jobs/501/trace";
    delays[tracePath] = 300;
    try {
      const result = await callTool(
        buildScope({}, { GITLAB_MCP_JOB_TIMEOUT_MS: "100" }),
        "gitlab_job_trace",
        { project: "itrend/cxutility", job_id: 501 },
      );
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^ERROR GITLAB_TIMEOUT: .*timed out after 100ms/);
    } finally {
      delete delays[tracePath];
    }
  });
});
