import { describe, it, expect } from "vitest";
import { HostAllowlist } from "../src/security/host-allowlist.js";
import { ErrorCodes } from "../src/errors.js";

const allowlist = new HostAllowlist(["git.tiddaw.net", "gitlab-uat.tiddaw.net"]);

describe("HostAllowlist", () => {
  it("accepts allowlisted hosts", () => {
    expect(allowlist.isAllowed("https://git.tiddaw.net/api/v4")).toBe(true);
    expect(allowlist.isAllowed("http://gitlab-uat.tiddaw.net")).toBe(true);
  });

  it("rejects foreign hosts with GITLAB_HOST_NOT_ALLOWED", () => {
    try {
      allowlist.check("https://evil.example.com/api/v4");
      expect.fail("should throw");
    } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCodes.GITLAB_HOST_NOT_ALLOWED);
    }
  });

  it("rejects internal/link-local targets (SSRF)", () => {
    expect(allowlist.isAllowed("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(allowlist.isAllowed("http://localhost:8080")).toBe(false);
    expect(allowlist.isAllowed("http://127.0.0.1")).toBe(false);
  });

  it("rejects lookalike hosts", () => {
    expect(allowlist.isAllowed("https://git.tiddaw.net.evil.com")).toBe(false);
  });

  it("is case-insensitive and tolerates trailing slash", () => {
    expect(new HostAllowlist(["GIT.Tiddaw.NET"]).isAllowed("https://git.tiddaw.net")).toBe(true);
  });
});
