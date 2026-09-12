import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  resolveListRequest,
  buildListResponse,
  hasMoreFromHeaders,
} from "../src/gitlab/pagination.js";
import { ErrorCodes, GatewayError } from "../src/errors.js";
import { truncateFromStart } from "../src/gitlab/response.js";

const limits = { defaultLimit: 20, maxLimit: 100 };

function headersOf(map: Record<string, string>) {
  return { get: (name: string) => map[name.toLowerCase()] ?? null };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    expect.fail("should throw");
  } catch (e) {
    expect((e as GatewayError).code).toBe(code);
  }
}

describe("cursor codec (FR-12)", () => {
  it("round-trips {page, per_page} opaquely", () => {
    const cursor = encodeCursor({ page: 3, per_page: 20 });
    expect(cursor).not.toContain("page"); // base64, internals not exposed
    expect(decodeCursor(cursor)).toEqual({ page: 3, per_page: 20 });
  });

  it("rejects tampered cursors with VALIDATION_ERROR", () => {
    expectCode(() => decodeCursor("!!!not-base64!!!"), ErrorCodes.VALIDATION_ERROR);
    expectCode(
      () => decodeCursor(Buffer.from(JSON.stringify({ page: 0, per_page: 20 })).toString("base64url")),
      ErrorCodes.VALIDATION_ERROR,
    );
    expectCode(
      () => decodeCursor(Buffer.from(JSON.stringify({ page: 2, per_page: 1000 })).toString("base64url")),
      ErrorCodes.VALIDATION_ERROR,
    );
    expectCode(
      () => decodeCursor(Buffer.from(JSON.stringify({ evil: true })).toString("base64url")),
      ErrorCodes.VALIDATION_ERROR,
    );
    expectCode(
      () => decodeCursor(Buffer.from("plain garbage").toString("base64url")),
      ErrorCodes.VALIDATION_ERROR,
    );
  });
});

describe("resolveListRequest (FR-12)", () => {
  it("defaults to limit 20, page 1", () => {
    expect(resolveListRequest({}, limits)).toEqual({ page: 1, per_page: 20, limit: 20 });
  });

  it("clamps limit above the max", () => {
    expect(resolveListRequest({ limit: 500 }, limits)).toEqual({ page: 1, per_page: 100, limit: 100 });
  });

  it("rejects non-positive limits", () => {
    expectCode(() => resolveListRequest({ limit: 0 }, limits), ErrorCodes.VALIDATION_ERROR);
    expectCode(() => resolveListRequest({ limit: -3 }, limits), ErrorCodes.VALIDATION_ERROR);
  });

  it("uses the cursor's page and per_page when present", () => {
    const cursor = encodeCursor({ page: 4, per_page: 50 });
    expect(resolveListRequest({ cursor, limit: 10 }, limits)).toEqual({
      page: 4,
      per_page: 50,
      limit: 50,
    });
  });
});

describe("buildListResponse has_more / next_cursor", () => {
  const items = Array.from({ length: 20 }, (_, i) => i);

  it("x-next-page presence is the primary signal", () => {
    const req = { page: 1, per_page: 20, limit: 20 };
    const more = buildListResponse(items, req, headersOf({ "x-next-page": "2" }));
    expect(more.pagination.has_more).toBe(true);
    expect(more.pagination.next_cursor).toBe(encodeCursor({ page: 2, per_page: 20 }));

    const last = buildListResponse(items, req, headersOf({ "x-next-page": "" }));
    expect(last.pagination).toEqual({ has_more: false, next_cursor: null });
  });

  it("falls back to x-total", () => {
    const req = { page: 1, per_page: 20, limit: 20 };
    const more = buildListResponse(items, req, headersOf({ "x-total": "45" }));
    expect(more.pagination.has_more).toBe(true);
    const done = buildListResponse(items, req, headersOf({ "x-total": "20" }));
    expect(done.pagination.has_more).toBe(false);
  });

  it("falls back to 'page was full' when no headers exist", () => {
    const req = { page: 1, per_page: 20, limit: 20 };
    expect(buildListResponse(items, req, headersOf({})).pagination.has_more).toBe(true);
    expect(buildListResponse(items.slice(0, 5), req, headersOf({})).pagination.has_more).toBe(false);
  });

  it("next_cursor round-trips into resolveListRequest", () => {
    const first = buildListResponse(
      items,
      { page: 1, per_page: 20, limit: 20 },
      headersOf({ "x-next-page": "2" }),
    );
    const next = resolveListRequest(
      { cursor: first.pagination.next_cursor! },
      limits,
    );
    expect(next).toEqual({ page: 2, per_page: 20, limit: 20 });
  });

  it("falls back to x-total when x-next-page is absent", () => {
    const h = headersOf({ "x-total": "45" });
    expect(hasMoreFromHeaders(h, 1, 20, 20)).toBe(true);
  });
});

describe("truncateFromStart (FR-13)", () => {
  it("passes small payloads through untouched", () => {
    const result = truncateFromStart("hello", { maxBytes: 100 });
    expect(result).toEqual({ content: "hello", truncated: false, original_bytes: 5 });
  });

  it("truncates from the start, keeping the end", () => {
    const text = "A".repeat(100) + "TAIL";
    const result = truncateFromStart(text, { maxBytes: 10 });
    expect(result.truncated).toBe(true);
    expect(result.original_bytes).toBe(104);
    expect(result.content).toBe("A".repeat(6) + "TAIL");
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(10);
  });

  it("includes the continuation hint when truncated", () => {
    const result = truncateFromStart("x".repeat(500), {
      maxBytes: 100,
      continuationHint: "pass offset=<bytes> to gitlab_job_trace",
    });
    expect(result.truncated).toBe(true);
    expect(result.continuation_hint).toBe("pass offset=<bytes> to gitlab_job_trace");
  });

  it("does not split multi-byte characters", () => {
    const text = "é".repeat(300); // 2 bytes each
    const result = truncateFromStart(text, { maxBytes: 100 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(100);
    expect(result.content).toMatch(/^é*$/u); // no replacement chars / split runes
  });
});
