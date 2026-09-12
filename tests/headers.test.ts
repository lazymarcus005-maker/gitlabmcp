import { describe, it, expect } from "vitest";
import { parseGitLabHeaders } from "../src/context/headers.js";
import { ErrorCodes } from "../src/errors.js";

const VALID = {
  "x-gitlab-url": "https://git.tiddaw.net/",
  "x-gitlab-token": "glpat-abc123",
};

describe("parseGitLabHeaders", () => {
  it("parses required headers", () => {
    const parsed = parseGitLabHeaders(VALID);
    expect(parsed.baseUrl).toBe("https://git.tiddaw.net");
    expect(parsed.token).toBe("glpat-abc123");
    expect(parsed.sslVerify).toBe(true);
    expect(parsed.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects missing X-GitLab-URL", () => {
    try {
      parseGitLabHeaders({ "x-gitlab-token": "t" });
      expect.fail("should throw");
    } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCodes.VALIDATION_ERROR);
    }
  });

  it("rejects missing X-GitLab-Token", () => {
    try {
      parseGitLabHeaders({ "x-gitlab-url": "https://git.tiddaw.net" });
      expect.fail("should throw");
    } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCodes.VALIDATION_ERROR);
    }
  });

  it("rejects malformed URL", () => {
    try {
      parseGitLabHeaders({ ...VALID, "x-gitlab-url": "not a url" });
      expect.fail("should throw");
    } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCodes.VALIDATION_ERROR);
    }
  });

  it("rejects non-http(s) protocols", () => {
    try {
      parseGitLabHeaders({ ...VALID, "x-gitlab-url": "file:///etc/passwd" });
      expect.fail("should throw");
    } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCodes.VALIDATION_ERROR);
    }
  });

  it("parses SSL-Verify: false", () => {
    const parsed = parseGitLabHeaders({ ...VALID, "x-gitlab-ssl-verify": "false" });
    expect(parsed.sslVerify).toBe(false);
  });

  it("defaults sslVerify to true", () => {
    expect(parseGitLabHeaders(VALID).sslVerify).toBe(true);
    expect(parseGitLabHeaders({ ...VALID, "x-gitlab-ssl-verify": "true" }).sslVerify).toBe(true);
  });

  it("parses defaults and csv scopes", () => {
    const parsed = parseGitLabHeaders({
      ...VALID,
      "x-gitlab-default-group": "itrend",
      "x-gitlab-default-project": "itrend/cxutility",
      "x-gitlab-project-scope": "itrend/*, other/proj",
      "x-gitlab-request-scope": "read,issue-write",
    });
    expect(parsed.defaultGroup).toBe("itrend");
    expect(parsed.defaultProject).toBe("itrend/cxutility");
    expect(parsed.projectScope).toEqual(["itrend/*", "other/proj"]);
    expect(parsed.requestedScopes).toEqual(["read", "issue-write"]);
  });
});
