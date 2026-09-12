/**
 * Per-request scope: carries the raw HTTP headers and server singletons
 * through AsyncLocalStorage so tool handlers can run the security gateway
 * without any global credential state.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { HeaderBag } from "./headers.js";
import type { ServerConfig } from "../config.js";
import type { IdentityResolver } from "../security/identity.js";
import type { HostAllowlist } from "../security/host-allowlist.js";

export interface RequestScope {
  headers: HeaderBag;
  config: ServerConfig;
  identityResolver: IdentityResolver;
  allowlist: HostAllowlist;
}

const als = new AsyncLocalStorage<RequestScope>();

export function runWithRequestScope<T>(
  scope: RequestScope,
  fn: () => T,
): T {
  return als.run(scope, fn);
}

export function getRequestScope(): RequestScope {
  const scope = als.getStore();
  if (!scope) {
    throw new Error("no request scope active — handler called outside a request");
  }
  return scope;
}
