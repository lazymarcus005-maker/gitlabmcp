import { describe, it, expect } from "vitest";
import { IdentityResolver } from "../src/security/identity.js";
import { ErrorCodes } from "../src/errors.js";

const IDENTITY = { id: 42, username: "marcus", name: "Marcus" };

function makeResolver(opts: { status?: number; ttlMs?: number; now?: () => number } = {}) {
  let calls = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls += 1;
    const token = new Headers(init?.headers).get("Authorization") ?? "";
    const status = opts.status ?? 200;
    return new Response(status === 200 ? JSON.stringify(IDENTITY) : '{"message":"401"}', {
      status,
    });
  };
  const resolver = new IdentityResolver({
    ttlMs: opts.ttlMs ?? 10 * 60 * 60 * 1000,
    fetchImpl,
    now: opts.now,
  });
  return { resolver, getCalls: () => calls };
}

describe("IdentityResolver", () => {
  it("resolves identity from /api/v4/user", async () => {
    const { resolver } = makeResolver();
    const identity = await resolver.resolve("https://git.tiddaw.net", "glpat-1");
    expect(identity).toEqual(IDENTITY);
  });

  it("caches by token hash: second resolve does not call /user again", async () => {
    const { resolver, getCalls } = makeResolver();
    await resolver.resolve("https://git.tiddaw.net", "glpat-1");
    const identity2 = await resolver.resolve("https://git.tiddaw.net", "glpat-1");
    expect(identity2).toEqual(IDENTITY);
    expect(getCalls()).toBe(1);
  });

  it("different tokens are different cache entries", async () => {
    const { resolver, getCalls } = makeResolver();
    await resolver.resolve("https://git.tiddaw.net", "glpat-1");
    await resolver.resolve("https://git.tiddaw.net", "glpat-2");
    expect(getCalls()).toBe(2);
  });

  it("expires after TTL and refetches", async () => {
    let time = 0;
    const { resolver, getCalls } = makeResolver({ ttlMs: 1000, now: () => time });
    await resolver.resolve("https://git.tiddaw.net", "glpat-1");
    time = 999;
    await resolver.resolve("https://git.tiddaw.net", "glpat-1");
    expect(getCalls()).toBe(1);
    time = 1001;
    await resolver.resolve("https://git.tiddaw.net", "glpat-1");
    expect(getCalls()).toBe(2);
  });

  it("rejects invalid tokens with GITLAB_TOKEN_INVALID", async () => {
    const { resolver } = makeResolver({ status: 401 });
    try {
      await resolver.resolve("https://git.tiddaw.net", "bad-token");
      expect.fail("should throw");
    } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCodes.GITLAB_TOKEN_INVALID);
    }
  });

  it("never stores the token in the cache", async () => {
    const { resolver } = makeResolver();
    await resolver.resolve("https://git.tiddaw.net", "glpat-super-secret");
    const dump = JSON.stringify(resolver);
    expect(dump).not.toContain("glpat-super-secret");
  });
});
