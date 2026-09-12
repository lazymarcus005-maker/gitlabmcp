/**
 * Pagination contract (FR-12, architecture §6/§7): tools returning lists
 * accept `{limit, cursor}`; the cursor is an opaque base64 encoding of
 * `{page, per_page}` — GitLab paging internals are never exposed to the
 * agent. Every list response is shaped `{items, pagination:{has_more,
 * next_cursor}}`.
 */
import { ErrorCodes, GatewayError } from "../errors.js";

export interface ListInput {
  limit?: number | null;
  cursor?: string | null;
}

export interface CursorPage {
  page: number;
  per_page: number;
}

export interface ListRequest extends CursorPage {
  /** Effective limit after defaulting/clamping (equals per_page). */
  limit: number;
}

export interface PaginationMeta {
  has_more: boolean;
  next_cursor: string | null;
}

export interface Paginated<T> {
  items: T[];
  pagination: PaginationMeta;
}

/** Minimal header view accepted from fetch `Headers` or plain test objects. */
export interface HeaderBag {
  get(name: string): string | null | undefined;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Opaque cursor: base64url of `{page, per_page}`. */
export function encodeCursor(cursor: CursorPage): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decodes an opaque cursor. Tamper resistance = strict structural
 * validation: anything that is not base64 `{page>=1, 1<=per_page<=100}`
 * is rejected with VALIDATION_ERROR rather than trusted.
 */
export function decodeCursor(cursor: string): CursorPage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new GatewayError(ErrorCodes.VALIDATION_ERROR, "invalid cursor");
  }
  const body = parsed as Partial<CursorPage> | null;
  if (
    body === null ||
    typeof body !== "object" ||
    !isPositiveInt(body.page) ||
    !isPositiveInt(body.per_page) ||
    body.per_page > 100
  ) {
    throw new GatewayError(ErrorCodes.VALIDATION_ERROR, "invalid cursor");
  }
  return { page: body.page, per_page: body.per_page };
}

/**
 * Translates the `{limit, cursor}` contract to GitLab `page`/`per_page`.
 * `limit` defaults to 20 and is clamped at the configured max (100);
 * a valid cursor's per_page wins over an incoming limit so pages stay
 * aligned across round-trips. GitLab per_page is capped at 100.
 */
export function resolveListRequest(
  input: ListInput,
  limits: { defaultLimit: number; maxLimit: number },
): ListRequest {
  const defaultLimit = Math.max(1, Math.min(limits.defaultLimit, limits.maxLimit, 100));
  const maxLimit = Math.max(1, Math.min(limits.maxLimit, 100));

  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    return { page: decoded.page, per_page: decoded.per_page, limit: decoded.per_page };
  }

  const requested = input.limit ?? defaultLimit;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 1) {
    throw new GatewayError(
      ErrorCodes.VALIDATION_ERROR,
      "limit must be a positive integer",
    );
  }
  const limit = Math.min(Math.floor(requested), maxLimit);
  return { page: 1, per_page: limit, limit };
}

/**
 * Derives `has_more` from GitLab list headers. `x-next-page` presence is
 * the primary signal; fall back to `x-total` vs. current position, then to
 * "page was full". Never exposes the headers themselves.
 */
export function hasMoreFromHeaders(
  headers: HeaderBag,
  page: number,
  perPage: number,
  itemCount: number,
): boolean {
  const nextPage = headers.get("x-next-page");
  if (nextPage !== null && nextPage !== undefined) {
    // Primary signal: the header's presence is authoritative, even when
    // empty (GitLab sends x-next-page: "" on the last page).
    return nextPage !== "";
  }
  const total = headers.get("x-total");
  if (total !== null && total !== undefined && total !== "" && Number.isFinite(Number(total))) {
    return page * perPage < Number(total);
  }
  return itemCount >= perPage;
}

/**
 * Shapes a GitLab list response into the agent-facing contract. Returns the
 * truncated-to-`perPage` items plus opaque continuation cursor when more
 * pages exist.
 */
export function buildListResponse<T>(
  items: T[],
  request: ListRequest,
  headers: HeaderBag,
): Paginated<T> {
  const trimmed = items.slice(0, request.per_page);
  const hasMore = hasMoreFromHeaders(headers, request.page, request.per_page, trimmed.length);
  return {
    items: trimmed,
    pagination: {
      has_more: hasMore,
      next_cursor: hasMore
        ? encodeCursor({ page: request.page + 1, per_page: request.per_page })
        : null,
    },
  };
}
