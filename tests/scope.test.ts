import { describe, it, expect } from "vitest";
import { compileProjectGlob, projectMatchesScope } from "../src/security/scope.js";

describe("compileProjectGlob", () => {
  it("matches an exact path", () => {
    expect(compileProjectGlob("itrend/cxutility").test("itrend/cxutility")).toBe(true);
    expect(compileProjectGlob("itrend/cxutility").test("itrend/cxgateway")).toBe(false);
  });

  it("`*` matches across path segments (nested subgroups, FR-8)", () => {
    const re = compileProjectGlob("itrend/*");
    expect(re.test("itrend/cxutility")).toBe(true);
    expect(re.test("itrend/team/alpha")).toBe(true);
    expect(re.test("itrend/team/alpha/sub/app")).toBe(true);
    expect(re.test("other/cxutility")).toBe(false);
  });

  it("a trailing `/*` also admits the prefix group itself", () => {
    expect(compileProjectGlob("itrend/*").test("itrend")).toBe(true);
  });

  it("deep globs constrain their prefix", () => {
    const re = compileProjectGlob("itrend/team/*");
    expect(re.test("itrend/team/alpha")).toBe(true);
    expect(re.test("itrend/team/alpha/app")).toBe(true);
    expect(re.test("itrend/cxutility")).toBe(false);
  });

  it("leading wildcard covers any namespace", () => {
    const re = compileProjectGlob("*/sandbox");
    expect(re.test("itrend/sandbox")).toBe(true);
    expect(re.test("a/b/sandbox")).toBe(true);
    expect(re.test("sandbox")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(compileProjectGlob("ITrend/*").test("itrend/cxutility")).toBe(true);
  });

  it("escapes regex metacharacters in literals", () => {
    const re = compileProjectGlob("a.b/c+d");
    expect(re.test("a.b/c+d")).toBe(true);
    expect(re.test("aXb/c+d")).toBe(false);
  });
});

describe("projectMatchesScope", () => {
  it("allows everything when no scope header was present", () => {
    expect(projectMatchesScope("anything/at/all", undefined)).toBe(true);
  });

  it("matches any pattern in the list", () => {
    const patterns = ["itrend/cxutility", "platform/*"];
    expect(projectMatchesScope("itrend/cxutility", patterns)).toBe(true);
    expect(projectMatchesScope("platform/api", patterns)).toBe(true);
    expect(projectMatchesScope("platform", patterns)).toBe(true);
    expect(projectMatchesScope("secret/project", patterns)).toBe(false);
  });

  it("rejects empty targets", () => {
    expect(projectMatchesScope("", ["itrend/*"])).toBe(false);
    expect(projectMatchesScope("/", ["itrend/*"])).toBe(false);
  });
});
