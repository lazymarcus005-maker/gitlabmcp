/**
 * Full end-to-end verification (architecture §11): the REAL server binary
 * (spawned as a child process) over REAL HTTP, driven through a genuine
 * sequential agent workflow against one stateful in-memory mock GitLab v4.
 *
 * Unlike tests/server.e2e.test.ts (in-process server, isolated stubs), this
 * suite shares mock state across endpoints: creating an issue really adds it
 * to the list, closing it really flips its state, merging an MR really
 * changes MR state, and a pipeline-status gate blocks merges. Every stage of
 * architecture §11 is exercised: identity → projects → issues → branches →
 * work items → MR lifecycle → CI (pipelines/jobs/traces) → content → cleanup,
 * plus the security e2e gates (allowlist, TLS policy, scope reduction,
 * read-only kill switch, audit redaction).
 *
 * Run: npx vitest run tests/e2e/e2e-workflow.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

const TOKEN = "glpat-e2e-workflow-secret-token";
const PROJECT_PATH = "e2e-team/alpha";
const ALL_SCOPES =
  "issue-write,mr-write,mr-merge,repo-write,pipeline-write,project-write";

// ---------------------------------------------------------------------------
// Stateful mock GitLab v4
// ---------------------------------------------------------------------------

interface MockIssue {
  id: number;
  iid: number;
  title: string;
  description?: string;
  state: "opened" | "closed";
  labels: string[];
  notes: Array<{ id: number; body: string }>;
}
interface MockLink {
  id: number;
  link_type: string;
  source_issue: { iid: number; title: string };
  target_issue: { iid: number; title: string };
}
interface MockMr {
  iid: number;
  source_branch: string;
  target_branch: string;
  title: string;
  state: "opened" | "merged" | "closed";
  head_pipeline: { id: number; status: string; ref: string } | null;
  notes: Array<{ id: number; body: string }>;
}
interface MockBranch {
  name: string;
  protected: boolean;
}
interface MockPipeline {
  id: number;
  status: string;
  ref: string;
}

const state = {
  nextIssueId: 100,
  nextIid: 10,
  nextLinkId: 500,
  nextNoteId: 900,
  nextMrIid: 20,
  issues: [] as MockIssue[],
  links: [] as MockLink[],
  mrs: [] as MockMr[],
  branches: [
    { name: "main", protected: true },
    { name: "develop", protected: false },
  ] as MockBranch[],
  pipelines: [
    { id: 101, status: "success", ref: "main" },
    { id: 102, status: "running", ref: "develop" },
  ] as MockPipeline[],
  nextPipelineId: 103,
  nextJobId: 600,
  jobs: [] as Array<{ id: number; pipeline_id: number; name: string; status: string; trace: string }>,
  milestones: [] as Array<{ id: number; title: string; state: string }>,
  wikis: [] as Array<{ slug: string; title: string; content: string }>,
  labels: [] as Array<{ name: string; color: string }>,
  userCalls: 0,
  protectedRefusals: 0,
};

/** Deterministic ~160KB job trace (ASCII, so byte offsets == char offsets). */
function buildBigTrace(): string {
  let trace = "";
  let line = 0;
  while (Buffer.byteLength(trace, "utf8") < 160 * 1024) {
    trace += `${String(line).padStart(6, "0")} running step ${line} of the e2e build ...\n`;
    line += 1;
  }
  return trace;
}
const BIG_TRACE = buildBigTrace();

const TREE = [
  { id: "a1", type: "tree", path: "src" },
  { id: "b2", type: "blob", path: "src/app.ts" },
  { id: "c3", type: "blob", path: "README.md" },
];

function projectByPath(decoded: string) {
  return decoded === PROJECT_PATH ? { id: 1, path_with_namespace: PROJECT_PATH } : null;
}

function findIssue(iid: number): MockIssue | undefined {
  return state.issues.find((i) => i.iid === iid);
}
function issueToApi(i: MockIssue) {
  return { ...i, notes: undefined, project_id: 1 };
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString("utf8")));
    req.on("end", () => resolve(data));
  });
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleGitLab(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  void (async () => {
    const rawUrl = req.url ?? "/";
    const [rawPath, rawQuery] = rawUrl.split("?");
    const path = rawPath as string;
    const query = new URLSearchParams(rawQuery ?? "");
    const method = (req.method ?? "GET").toUpperCase();

    // Auth check on every API route.
    if (path.startsWith("/api/")) {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return json(res, 401, { message: "401 Unauthorized" });
      }
    }

    if (path === "/api/v4/user") {
      state.userCalls += 1;
      return json(res, 200, { id: 42, username: "marcus", name: "Marcus Y" });
    }
    if (path === "/api/v4/version") {
      return json(res, 200, { version: "18.8.3-ee", revision: "e2e" });
    }

    // GET /api/v4/projects — list with pagination headers.
    if (path === "/api/v4/projects" && method === "GET") {
      const projects = [
        {
          id: 1,
          path_with_namespace: PROJECT_PATH,
          name: "alpha",
          default_branch: "main",
          visibility: "private",
          description: "e2e target project",
        },
        {
          id: 2,
          path_with_namespace: "other/beta",
          name: "beta",
          default_branch: "main",
          visibility: "private",
          description: "out of scope project",
        },
      ];
      const page = Number(query.get("page") ?? "1");
      const perPage = Number(query.get("per_page") ?? "20");
      const slice = projects.slice((page - 1) * perPage, page * perPage);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Total": String(projects.length),
        "X-Page": String(page),
        "X-Next-Page": page * perPage < projects.length ? String(page + 1) : "",
      });
      res.end(JSON.stringify(slice));
      return;
    }

    // Everything below: /api/v4/projects/<encoded-path-or-id>/...
    const m = path.match(/^\/api\/v4\/projects\/([^/]+)(\/.*)?$/);
    if (m) {
      const project = projectByPath(decodeURIComponent(m[1] as string));
      if (!project) return json(res, 404, { message: "404 Project Not Found" });
      const sub = m[2] ?? "/";

      // GET /api/v4/projects/<p> — single project metadata.
      if (sub === "/" && method === "GET") {
        return json(res, 200, {
          id: project.id,
          path_with_namespace: PROJECT_PATH,
          name: "alpha",
          default_branch: "main",
          visibility: "private",
          description: "e2e target project",
        });
      }

      // ---- Issues ----
      let sm = sub.match(/^\/issues$/);
      if (sm) {
        if (method === "GET") return json(res, 200, state.issues.map(issueToApi));
        if (method === "POST") {
          const body = JSON.parse(await readBody(req));
          const issue: MockIssue = {
            id: state.nextIssueId++,
            iid: state.nextIid++,
            title: body.title,
            description: body.description ?? "",
            state: "opened",
            labels: typeof body.labels === "string" ? body.labels.split(",") : [],
            notes: [],
          };
          state.issues.push(issue);
          return json(res, 201, issueToApi(issue));
        }
      }
      sm = sub.match(/^\/issues\/(\d+)$/);
      if (sm) {
        const issue = findIssue(Number(sm[1]));
        if (!issue) return json(res, 404, { message: "404 Issue Not Found" });
        if (method === "GET") return json(res, 200, issueToApi(issue));
        // GitLab v4 accepts both PUT and POST with state_event on /issues/:iid;
        // gitlab_issue_close / gitlab_issue_reopen use POST.
        if (method === "PUT" || method === "POST") {
          const body = JSON.parse(await readBody(req));
          if (typeof body.title === "string") issue.title = body.title;
          if (typeof body.description === "string") issue.description = body.description;
          if (typeof body.labels === "string") issue.labels = body.labels.split(",");
          if (body.state_event === "close") issue.state = "closed";
          if (body.state_event === "reopen") issue.state = "opened";
          return json(res, 200, issueToApi(issue));
        }
      }
      sm = sub.match(/^\/issues\/(\d+)\/notes$/);
      if (sm && method === "POST") {
        const issue = findIssue(Number(sm[1]));
        if (!issue) return json(res, 404, { message: "404 Issue Not Found" });
        const body = JSON.parse(await readBody(req));
        const note = { id: state.nextNoteId++, body: body.body };
        issue.notes.push(note);
        return json(res, 201, note);
      }

      // ---- Issue links (work item dependencies) ----
      sm = sub.match(/^\/issues\/(\d+)\/links$/);
      if (sm) {
        const iid = Number(sm[1]);
        if (method === "GET") {
          return json(
            res,
            200,
            state.links.filter((l) => l.source_issue.iid === iid || l.target_issue.iid === iid),
          );
        }
        if (method === "POST") {
          const body = JSON.parse(await readBody(req));
          const source = findIssue(iid);
          const target = findIssue(Number(body.target_issue_iid));
          if (!source || !target) return json(res, 404, { message: "404 Issue Not Found" });
          const link: MockLink = {
            id: state.nextLinkId++,
            link_type: body.link_type,
            source_issue: { iid: source.iid, title: source.title },
            target_issue: { iid: target.iid, title: target.title },
          };
          state.links.push(link);
          return json(res, 201, link);
        }
      }
      sm = sub.match(/^\/issues\/(\d+)\/links\/(\d+)$/);
      if (sm && method === "DELETE") {
        const linkId = Number(sm[2]);
        const idx = state.links.findIndex((l) => l.id === linkId);
        if (idx >= 0) state.links.splice(idx, 1);
        return json(res, 200, { message: "unlinked" });
      }

      // ---- Branches ----
      sm = sub.match(/^\/repository\/branches$/);
      if (sm && method === "POST") {
        const body = JSON.parse(await readBody(req));
        const branchName: string = body.branch;
        if (state.branches.some((b) => b.name.toLowerCase() === branchName.toLowerCase())) {
          return json(res, 400, { message: "Branch already exists" });
        }
        if (["main", "master", "uat", "production"].includes(branchName.toLowerCase())) {
          state.protectedRefusals += 1;
          return json(res, 400, { message: `Protected branch ${branchName} cannot be created` });
        }
        const branch: MockBranch = { name: branchName, protected: false };
        state.branches.push(branch);
        return json(res, 201, { name: branch.name, protected: false, commit: { id: "abc123" } });
      }
      sm = sub.match(/^\/repository\/branches\/(.+)$/);
      if (sm) {
        const branchName = decodeURIComponent(sm[1] as string);
        const branch = state.branches.find((b) => b.name === branchName);
        if (method === "GET") {
          if (!branch) return json(res, 404, { message: "404 Branch Not Found" });
          return json(res, 200, {
            name: branch.name,
            protected: branch.protected,
            commit: { id: "abc123" },
          });
        }
        if (method === "DELETE") {
          if (!branch) return json(res, 404, { message: "404 Branch Not Found" });
          if (branch.protected) {
            state.protectedRefusals += 1;
            return json(res, 403, { message: "Protected branch cannot be deleted" });
          }
          state.branches = state.branches.filter((b) => b !== branch);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({}));
          return;
        }
      }

      // ---- Repository tree ----
      if (sub === "/repository/tree" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(TREE));
        return;
      }

      // ---- Merge requests ----
      if (sub === "/merge_requests" && method === "GET") {
        return json(res, 200, state.mrs);
      }
      if (sub === "/merge_requests" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        const sourceBranch: string = body.source_branch;
        if (!state.branches.some((b) => b.name === sourceBranch)) {
          return json(res, 400, { message: `Source branch ${sourceBranch} does not exist` });
        }
        // Pipeline-status gate fixture: a "broken" source branch gets a
        // running pipeline, so merging must be refused (405).
        const broken = sourceBranch.includes("broken");
        const mr: MockMr = {
          iid: state.nextMrIid++,
          source_branch: sourceBranch,
          target_branch: body.target_branch,
          title: body.title,
          state: "opened",
          head_pipeline: broken
            ? { id: 199, status: "running", ref: sourceBranch }
            : { id: 101, status: "success", ref: sourceBranch },
          notes: [],
        };
        state.mrs.push(mr);
        return json(res, 201, mr);
      }
      sm = sub.match(/^\/merge_requests\/(\d+)$/);
      if (sm) {
        const mr = state.mrs.find((x) => x.iid === Number(sm[1]));
        if (!mr) return json(res, 404, { message: "404 MR Not Found" });
        if (method === "GET") return json(res, 200, mr);
        if (method === "PUT") {
          const body = JSON.parse(await readBody(req));
          if (typeof body.title === "string") mr.title = body.title;
          if (body.state_event === "close") mr.state = "closed";
          if (body.state_event === "reopen") mr.state = "opened";
          return json(res, 200, mr);
        }
      }
      sm = sub.match(/^\/merge_requests\/(\d+)\/diffs$/);
      if (sm && method === "GET") {
        return json(res, 200, [
          {
            old_path: "src/app.ts",
            new_path: "src/app.ts",
            diff: "@@ -1,3 +1,4 @@\n e2e change for branch feature/e2e\n+added line\n",
          },
        ]);
      }
      sm = sub.match(/^\/merge_requests\/(\d+)\/notes$/);
      if (sm && method === "POST") {
        const mr = state.mrs.find((x) => x.iid === Number(sm[1]));
        if (!mr) return json(res, 404, { message: "404 MR Not Found" });
        const body = JSON.parse(await readBody(req));
        const note = { id: state.nextNoteId++, body: body.body };
        mr.notes.push(note);
        return json(res, 201, note);
      }
      sm = sub.match(/^\/merge_requests\/(\d+)\/merge$/);
      if (sm && (method === "POST" || method === "PUT")) {
        const mr = state.mrs.find((x) => x.iid === Number(sm[1]));
        if (!mr) return json(res, 404, { message: "404 MR Not Found" });
        if (mr.state !== "opened") {
          return json(res, 405, { message: "405 Method Not Allowed - MR is not open" });
        }
        if (mr.head_pipeline && mr.head_pipeline.status !== "success") {
          return json(res, 405, {
            message: "405 Method Not Allowed - pipeline must succeed before merge",
          });
        }
        mr.state = "merged";
        return json(res, 200, mr);
      }

      // ---- Pipelines ----
      if (sub === "/pipelines" && method === "GET") {
        return json(res, 200, state.pipelines);
      }
      sm = sub.match(/^\/pipelines\/(\d+)$/);
      if (sm && method === "GET") {
        const p = state.pipelines.find((x) => x.id === Number(sm[1]));
        if (!p) return json(res, 404, { message: "404 Pipeline Not Found" });
        return json(res, 200, { ...p, project_id: 1 });
      }
      sm = sub.match(/^\/pipelines\/(\d+)\/(retry|cancel)$/);
      if (sm && method === "POST") {
        const p = state.pipelines.find((x) => x.id === Number(sm[1]));
        if (!p) return json(res, 404, { message: "404 Pipeline Not Found" });
        p.status = sm[2] === "retry" ? "running" : "canceled";
        return json(res, 201, p);
      }

      // ---- Jobs ----
      if (sub === "/jobs" && method === "GET") {
        return json(res, 200, state.jobs);
      }
      sm = sub.match(/^\/jobs\/(\d+)\/trace$/);
      if (sm && method === "GET") {
        const job = state.jobs.find((x) => x.id === Number(sm[1]));
        if (!job) return json(res, 404, { message: "404 Job Not Found" });
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(job.trace);
        return;
      }
      sm = sub.match(/^\/jobs\/(\d+)$/);
      if (sm && method === "GET") {
        const job = state.jobs.find((x) => x.id === Number(sm[1]));
        if (!job) return json(res, 404, { message: "404 Job Not Found" });
        const { trace, ...rest } = job;
        return json(res, 200, rest);
      }

      // ---- Milestones / wiki / labels ----
      if (sub === "/milestones" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        const ms = {
          id: state.nextPipelineId++ + 700,
          title: body.title,
          state: "active",
        };
        state.milestones.push(ms);
        return json(res, 201, ms);
      }
      if (sub === "/wikis" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        const page = {
          slug: String(body.title).toLowerCase().replace(/\s+/g, "-"),
          title: body.title,
          content: body.content,
        };
        state.wikis.push(page);
        return json(res, 201, page);
      }
      if (sub === "/labels" && method === "POST") {
        const body = JSON.parse(await readBody(req));
        const label = { name: body.name, color: body.color };
        state.labels.push(label);
        return json(res, 201, label);
      }
    }

    return json(res, 404, { message: `404 mock gitlab has no route for ${method} ${path}` });
  })().catch((err) => {
    json(res, 500, { message: String(err) });
  });
}

// ---------------------------------------------------------------------------
// Child-process MCP server plumbing (mirrors tests/smoke/smoke.test.ts)
// ---------------------------------------------------------------------------

const here = new URL(".", import.meta.url).pathname;
const serverJs = new URL("../../dist/index.js", import.meta.url).pathname;

let child: ReturnType<typeof spawn> | undefined;
let readonlyChild: ReturnType<typeof spawn> | undefined;
let gitlab: Server | undefined;
let mcpUrl = "";
let readonlyMcpUrl = "";
let stdoutText = "";
let nextId = 1;

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

async function startServer(extraEnv: Record<string, string>, pipeStdout: boolean) {
  const port = await freePort();
  const proc = spawn(process.execPath, [serverJs], {
    env: {
      ...process.env,
      GITLAB_MCP_PORT: String(port),
      GITLAB_MCP_ALLOWED_HOSTS: "127.0.0.1,git.example.com",
      GITLAB_MCP_DISABLE_VERIFY_HOSTS: "127.0.0.1",
      ...extraEnv,
    },
    stdio: pipeStdout ? ["ignore", "pipe", "inherit"] : ["ignore", "ignore", "inherit"],
  });
  if (pipeStdout) {
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => (stdoutText += chunk));
  }
  const url = `http://127.0.0.1:${port}/mcp`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${new URL(url).origin}/health`);
      if (res.ok) return { proc, url };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("MCP server did not become healthy within 15s");
}

async function rpc(
  url: string,
  method: string,
  params: unknown,
  headers: Record<string, string> = {},
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-GitLab-URL": gitlabUrl,
      "X-GitLab-Token": TOKEN,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}

let gitlabUrl = "";

interface CallResult {
  text: string;
  isError: boolean;
  data: any;
}

async function call(
  tool: string,
  args: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  url = mcpUrl,
): Promise<CallResult> {
  const body = await rpc(
    url,
    "tools/call",
    { name: tool, arguments: args },
    { "X-GitLab-Request-Scope": ALL_SCOPES, ...extraHeaders },
  );
  expect(body.error).toBeUndefined();
  const result = body.result;
  const text = result?.content?.[0]?.text ?? "";
  return { text, isError: result?.isError === true, data: result };
}

function expectOk(r: CallResult) {
  expect(r.isError).toBe(false);
  return JSON.parse(r.text);
}

function expectError(r: CallResult, code: string) {
  expect(r.isError).toBe(true);
  expect(r.text).toContain(code);
  return r;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  gitlab = createHttpServer(handleGitLab);
  await new Promise<void>((r) => gitlab!.listen(0, "127.0.0.1", r));
  const ga = gitlab.address() as AddressInfo;
  gitlabUrl = `http://127.0.0.1:${ga.port}`;

  const main = await startServer(
    { GITLAB_MCP_IDENTITY_CACHE_TTL_MS: "3600000" },
    true, // capture stdout for audit assertions
  );
  child = main.proc;
  mcpUrl = main.url;

  const ro = await startServer({ GITLAB_MCP_READ_ONLY: "true" }, false);
  readonlyChild = ro.proc;
  readonlyMcpUrl = ro.url;
}, 30_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  readonlyChild?.kill("SIGTERM");
  await new Promise<void>((r) => gitlab?.close(() => r()));
});

describe("e2e: MCP handshake", () => {
  it("initialize succeeds over real HTTP", async () => {
    const body = await rpc(mcpUrl, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "gitlabmcp-e2e", version: "0.1.0" },
    });
    expect(body.result?.serverInfo?.name).toBeTruthy();
  });

  it("tools/list exposes the workflow tools", async () => {
    const body = await rpc(mcpUrl, "tools/list", {});
    const names: string[] = (body.result?.tools ?? []).map((t: { name: string }) => t.name);
    for (const required of [
      "gitlab_system_current_user",
      "gitlab_project_get",
      "gitlab_issue_create",
      "gitlab_branch_create",
      "gitlab_work_item_add_child",
      "gitlab_mr_create",
      "gitlab_job_trace",
      "gitlab_milestone_create",
      "gitlab_branch_delete",
    ]) {
      expect(names).toContain(required);
    }
  });
});

describe("e2e: architecture §11 agent workflow", () => {
  it("step 1: identity + system info", async () => {
    const user = expectOk(await call("gitlab_system_current_user", {}));
    expect(user.username).toBe("marcus");
    const info = expectOk(await call("gitlab_system_info", {}));
    expect(info.gitlab_version).toBe("18.8.3-ee");
  });

  it("step 2: project get + scope-filtered project list", async () => {
    const project = expectOk(
      await call("gitlab_project_get", { project: PROJECT_PATH }),
    );
    expect(project.path_with_namespace).toBe(PROJECT_PATH);
    expect(project.default_branch).toBe("main");

    const filtered = expectOk(
      await call(
        "gitlab_project_list",
        {},
        { "X-GitLab-Project-Scope": "e2e-team/*" },
      ),
    );
    expect(Array.isArray(filtered.items)).toBe(true);
    const paths = filtered.items.map((p: { path_with_namespace: string }) => p.path_with_namespace);
    expect(paths).toContain(PROJECT_PATH);
    expect(paths).not.toContain("other/beta");

    const error = expectError(
      await call("gitlab_project_get", { project: "other/beta" }, {
        "X-GitLab-Project-Scope": "e2e-team/*",
      }),
      "SCOPE_PROJECT_NOT_ALLOWED",
    );
    expect(error.text).toContain("other/beta");
  });

  it("step 3: issue create → comment → close → reopen", async () => {
    const created = expectOk(
      await call("gitlab_issue_create", {
        project: PROJECT_PATH,
        title: "e2e: ship the workflow",
        description: "Created by the e2e workflow suite",
        labels: "e2e,workflow",
      }),
    );
    expect(created.state).toBe("opened");
    expect(created.iid).toBeGreaterThan(0);

    const note = expectOk(
      await call("gitlab_issue_comment", {
        project: PROJECT_PATH,
        iid: created.iid,
        body: "starting work",
      }),
    );
    expect(note.body).toBe("starting work");

    const closed = expectOk(
      await call("gitlab_issue_close", { project: PROJECT_PATH, iid: created.iid }),
    );
    expect(closed.state).toBe("closed");

    const reopened = expectOk(
      await call("gitlab_issue_reopen", { project: PROJECT_PATH, iid: created.iid }),
    );
    expect(reopened.state).toBe("opened");

    // State is genuinely shared: the created issue is really in the list.
    const list = expectOk(
      await call("gitlab_issue_list", { project: PROJECT_PATH, search: "workflow" }),
    );
    expect(list.items.some((i: { iid: number }) => i.iid === created.iid)).toBe(true);
  });

  it("step 4: branch create (feature/e2e) + protected main denial", async () => {
    const created = expectOk(
      await call("gitlab_branch_create", {
        project: PROJECT_PATH,
        branch: "feature/e2e",
        ref: "main",
      }),
    );
    expect(created.name).toBe("feature/e2e");

    const denied = expectError(
      await call("gitlab_branch_create", { project: PROJECT_PATH, branch: "main", ref: "main" }),
      "POLICY_BRANCH_PROTECTED",
    );
    expect(denied.text).toContain("main");
  });

  it("step 5: work item add_child → children → link (blocks) → unlink", async () => {
    const parent = expectOk(
      await call("gitlab_issue_create", {
        project: PROJECT_PATH,
        title: "e2e: parent work item",
      }),
    );
    const child = expectOk(
      await call("gitlab_issue_create", {
        project: PROJECT_PATH,
        title: "e2e: child work item",
      }),
    );

    const added = expectOk(
      await call("gitlab_work_item_add_child", {
        project: PROJECT_PATH,
        iid: parent.iid,
        child_iid: child.iid,
      }),
    );
    expect(added.added).toBe(true);

    const children = expectOk(
      await call("gitlab_work_item_children", { project: PROJECT_PATH, iid: parent.iid }),
    );
    expect(children.items).toEqual([
      { iid: child.iid, title: child.title, checked: false },
    ]);

    const link = expectOk(
      await call("gitlab_work_item_link", {
        project: PROJECT_PATH,
        iid: parent.iid,
        target_iid: child.iid,
        link_type: "blocks",
      }),
    );
    expect(link.link_type).toBe("blocks");

    const unlinked = expectOk(
      await call("gitlab_work_item_unlink", {
        project: PROJECT_PATH,
        iid: parent.iid,
        target_iid: child.iid,
      }),
    );
    expect(unlinked.unlinked).toBe(true);
  });

  it("step 6: mr create → diff → comment → merge-scope denial → merge", async () => {
    const mr = expectOk(
      await call("gitlab_mr_create", {
        project: PROJECT_PATH,
        source_branch: "feature/e2e",
        target_branch: "main",
        title: "e2e: merge the workflow branch",
        description: "closes the e2e issue",
      }),
    );
    expect(mr.state).toBe("opened");
    expect(mr.head_pipeline.status).toBe("success");

    const diff = await call("gitlab_mr_diff", { project: PROJECT_PATH, mr_iid: mr.iid });
    expect(diff.isError).toBe(false);
    const diffPayload = JSON.parse(diff.text);
    expect(diffPayload.files[0].new_path).toBe("src/app.ts");
    expect(diffPayload.files[0].diff).toContain("e2e change");

    const note = expectOk(
      await call("gitlab_mr_comment", {
        project: PROJECT_PATH,
        mr_iid: mr.iid,
        body: "LGTM after e2e",
      }),
    );
    expect(note.body).toBe("LGTM after e2e");

    // mr-merge scope gate: holding only mr-write must deny the merge.
    const deniedMerge = expectError(
      await call(
        "gitlab_mr_merge",
        { project: PROJECT_PATH, mr_iid: mr.iid },
        { "X-GitLab-Request-Scope": "mr-write" },
      ),
      "POLICY_SCOPE_MISSING",
    );
    expect(deniedMerge.text).toContain("mr-merge");

    // Pipeline-status gating: an MR whose pipeline is running cannot merge.
    await expectOk(
      await call("gitlab_branch_create", {
        project: PROJECT_PATH,
        branch: "feature/broken-pipeline",
        ref: "main",
      }),
    );
    const brokenMr = expectOk(
      await call("gitlab_mr_create", {
        project: PROJECT_PATH,
        source_branch: "feature/broken-pipeline",
        target_branch: "main",
        title: "e2e: gated by pipeline status",
      }),
    );
    expect(brokenMr.head_pipeline.status).toBe("running");
    const gated = await call("gitlab_mr_merge", { project: PROJECT_PATH, mr_iid: brokenMr.iid });
    expectError(gated, "405");

    const merged = expectOk(
      await call("gitlab_mr_merge", { project: PROJECT_PATH, mr_iid: mr.iid }),
    );
    expect(merged.state).toBe("merged");

    // State is really shared: the merged state shows up in a fresh fetch.
    const refetched = expectOk(
      await call("gitlab_mr_get", { project: PROJECT_PATH, mr_iid: mr.iid }),
    );
    expect(refetched.state).toBe("merged");
  });

  it("step 7: pipeline list/get, pipeline retry/cancel, job trace continuation", async () => {
    const pipelines = expectOk(await call("gitlab_pipeline_list", { project: PROJECT_PATH }));
    expect(pipelines.items.length).toBeGreaterThanOrEqual(2);

    const got = expectOk(
      await call("gitlab_pipeline_get", { project: PROJECT_PATH, pipeline_id: 101 }),
    );
    expect(got.status).toBe("success");

    const retried = expectOk(
      await call("gitlab_pipeline_retry", { project: PROJECT_PATH, pipeline_id: 102 }),
    );
    expect(retried.status).toBe("running");

    const canceled = expectOk(
      await call("gitlab_pipeline_cancel", { project: PROJECT_PATH, pipeline_id: 102 }),
    );
    expect(canceled.status).toBe("canceled");

    // Register a job with a >100KB trace in the mock.
    state.jobs.push({
      id: 601,
      pipeline_id: 101,
      name: "e2e-build",
      status: "success",
      trace: BIG_TRACE,
    });
    const job = expectOk(await call("gitlab_job_get", { project: PROJECT_PATH, job_id: 601 }));
    expect(job.name).toBe("e2e-build");

    // Walk the WHOLE trace via offset continuation, reassemble, compare.
    const chunks: string[] = [];
    let offset = 0;
    let firstTruncation: boolean | undefined;
    for (let hop = 0; hop < 10; hop += 1) {
      const trace = expectOk(
        await call("gitlab_job_trace", { project: PROJECT_PATH, job_id: 601, offset }),
      );
      if (hop === 0) {
        firstTruncation = trace.truncated;
        expect(trace.truncated).toBe(true); // >100KB must be truncated
        expect(trace.original_bytes).toBe(Buffer.byteLength(BIG_TRACE, "utf8"));
      }
      chunks.push(trace.content);
      if (!trace.truncated) break;
      offset = trace.next_offset;
    }
    expect(firstTruncation).toBe(true);
    expect(chunks.join("")).toBe(BIG_TRACE);
  });

  it("step 8: milestone / wiki / label creation (project-write)", async () => {
    const ms = expectOk(
      await call("gitlab_milestone_create", { project: PROJECT_PATH, title: "e2e Sprint 1" }),
    );
    expect(ms.title).toBe("e2e Sprint 1");

    const wiki = expectOk(
      await call("gitlab_wiki_create", {
        project: PROJECT_PATH,
        title: "e2e Runbook",
        content: "# how to run the e2e suite",
      }),
    );
    expect(wiki.slug).toBe("e2e-runbook");

    const label = expectOk(
      await call("gitlab_label_create", {
        project: PROJECT_PATH,
        name: "e2e",
        color: "#00AA00",
      }),
    );
    expect(label.name).toBe("e2e");
  });

  it("step 9: branch delete on the feature branch", async () => {
    const deleted = expectOk(
      await call("gitlab_branch_delete", { project: PROJECT_PATH, branch: "feature/e2e" }),
    );
    expect(deleted.deleted).toBe(true);
    const gone = expectError(
      await call("gitlab_branch_get", { project: PROJECT_PATH, branch: "feature/e2e" }),
      "404",
    );
    expect(gone.isError).toBe(true);
  });
});

describe("e2e: security gates in the same flow", () => {
  it("bad host header → GITLAB_HOST_NOT_ALLOWED as isError (HTTP 200)", async () => {
    const r = await call(
      "gitlab_system_current_user",
      {},
      { "X-GitLab-URL": "https://evil.example.com" },
    );
    expectError(r, "GITLAB_HOST_NOT_ALLOWED");
  });

  it("SSL-Verify:false on non-exempt host → POLICY_TLS_VERIFY_FORBIDDEN", async () => {
    const r = await call(
      "gitlab_system_current_user",
      {},
      {
        "X-GitLab-URL": "https://git.example.com",
        "X-GitLab-SSL-Verify": "false",
      },
    );
    expectError(r, "POLICY_TLS_VERIFY_FORBIDDEN");
  });

  it("read-only scope session attempting issue create → POLICY_SCOPE_MISSING", async () => {
    const r = await call(
      "gitlab_issue_create",
      { project: PROJECT_PATH, title: "should be denied" },
      { "X-GitLab-Request-Scope": "read" },
    );
    expectError(r, "POLICY_SCOPE_MISSING");
  });

  it("GITLAB_MCP_READ_ONLY=true server denies WRITE as isError", async () => {
    const r = await call(
      "gitlab_issue_create",
      { project: PROJECT_PATH, title: "read-only server" },
      {},
      readonlyMcpUrl,
    );
    expectError(r, "POLICY_OPERATION_DENIED");
    expect(r.text).toContain("read-only");
  });

  it("audit lines: username present, token never present", async () => {
    // Flush a final call so its audit line is definitely captured.
    await call("gitlab_system_current_user", {});
    await new Promise((r) => setTimeout(r, 200));
    const lines = stdoutText
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .map((l) => JSON.parse(l))
      .filter((r) => typeof r.tool === "string");
    expect(lines.length).toBeGreaterThan(0);
    for (const record of lines) {
      expect(typeof record.gitlab?.username).toBe("string");
      // Calls rejected before identity resolution (bad host, TLS policy)
      // audit as "unresolved"; every call that got past the gateway knows
      // the caller.
      if (record.result === "success") {
        expect(record.gitlab.username).toBe("marcus");
      } else {
        expect(["marcus", "unresolved"]).toContain(record.gitlab.username);
      }
      expect(JSON.stringify(record)).not.toContain(TOKEN);
      expect(record.tool).toMatch(/^gitlab_/);
      expect(["success", "error"]).toContain(record.result);
    }
    // At least one successful audit line must carry the resolved identity.
    expect(lines.some((r) => r.result === "success" && r.gitlab.username === "marcus")).toBe(true);
  });
});
