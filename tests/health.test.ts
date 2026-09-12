import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpServer } from "../src/server/http-server.js";
import { loadConfig } from "../src/config.js";
import type { AddressInfo } from "node:net";

describe("GET /health (NFR-4)", () => {
  let url: string;
  let server: ReturnType<typeof createHttpServer>;

  beforeAll(async () => {
    server = createHttpServer(
      loadConfig({ GITLAB_MCP_ALLOWED_HOSTS: "127.0.0.1" } as NodeJS.ProcessEnv),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("returns 200 ok without credentials", async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("leaves unknown paths at 404", async () => {
    const res = await fetch(`${url}/nope`);
    expect(res.status).toBe(404);
  });
});
