import { describe, it, expect } from "vitest";
import { redact } from "../src/security/redaction.js";
import { auditToolCall } from "../src/audit/logger.js";

describe("redact", () => {
  it("redacts PAT tokens", () => {
    expect(redact("token=glpat-abcdefghij1234")).not.toContain("glpat-abcdefghij1234");
  });

  it("redacts Authorization / Bearer headers", () => {
    const out = redact({ authorization: "Bearer glpat-abcdefghij" });
    expect(JSON.stringify(out)).not.toContain("glpat-abcdefghij");
  });

  it("redacts generic secret fields", () => {
    const out = JSON.stringify(
      redact({ secret: "hunter2", password: "pw", note: "hello" }),
    );
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("hello");
  });

  it("leaves normal audit content untouched", () => {
    const rec = {
      request_id: "req-1",
      gitlab: { host: "git.tiddaw.net", user_id: 1, username: "marcus" },
      tool: "gitlab_system_current_user",
      result: "success",
      duration_ms: 5,
    };
    expect(redact(rec)).toEqual(rec);
  });
});

describe("auditToolCall", () => {
  it("writes one JSON line to stdout without the token", () => {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      auditToolCall({
        request_id: "req-1",
        gitlab: { host: "git.tiddaw.net", user_id: 42, username: "marcus" },
        tool: "gitlab_system_current_user",
        result: "success",
        duration_ms: 12,
      });
    } finally {
      process.stdout.write = original;
    }
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({
      request_id: "req-1",
      gitlab: { host: "git.tiddaw.net", user_id: 42, username: "marcus" },
      tool: "gitlab_system_current_user",
      result: "success",
      duration_ms: 12,
    });
    expect(lines[0]).not.toContain("glpat-");
  });
});
