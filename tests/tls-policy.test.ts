import { describe, it, expect } from "vitest";
import { resolveTlsVerify } from "../src/security/tls-policy.js";
import { ErrorCodes } from "../src/errors.js";

const config = {
  allowDisableVerify: true,
  disableVerifyHosts: ["git.tiddaw.net"],
};

describe("resolveTlsVerify", () => {
  it("verify=true is always allowed", () => {
    expect(resolveTlsVerify("https://evil.example.com", true, config)).toBe(true);
  });

  it("verify=false allowed for hosts in disable_verify_hosts", () => {
    expect(resolveTlsVerify("https://git.tiddaw.net", false, config)).toBe(false);
  });

  it("verify=false forbidden otherwise → POLICY_TLS_VERIFY_FORBIDDEN", () => {
    try {
      resolveTlsVerify("https://gitlab-uat.tiddaw.net", false, config);
      expect.fail("should throw");
    } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCodes.POLICY_TLS_VERIFY_FORBIDDEN);
    }
  });

  it("verify=false forbidden when allow_disable_verify is off", () => {
    try {
      resolveTlsVerify("https://git.tiddaw.net", false, {
        allowDisableVerify: false,
        disableVerifyHosts: ["git.tiddaw.net"],
      });
      expect.fail("should throw");
    } catch (e) {
      expect((e as { code: string }).code).toBe(ErrorCodes.POLICY_TLS_VERIFY_FORBIDDEN);
    }
  });
});
