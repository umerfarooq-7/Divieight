/**
 * Where an audit row came from. Every row the server writes to the Audit Vault is given the request's address, browser and route when the code that wrote
 * it did not say (the payload's own values are never overwritten). The database lifts these into the ip_address, user_agent and route columns.
 */
import { getRequest, getRequestIP } from "@tanstack/react-start/server";

export interface AuditRequestContext {
  ip: string | null;
  userAgent: string | null;
  route: string | null;
}

/** The page the person was on (the Referer's path), else the path that was called. A server-function call's own URL is not a route anyone would recognise. */
export function routeOf(url: string | null | undefined, referer: string | null | undefined): string | null {
  for (const candidate of [referer, url]) {
    if (!candidate) continue;
    try {
      return new URL(candidate, "http://local").pathname.slice(0, 300);
    } catch {
      /* try the next */
    }
  }
  return null;
}

export function currentAuditContext(): AuditRequestContext {
  try {
    const req = getRequest();
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: req.headers.get("user-agent"), route: routeOf(req.url, req.headers.get("referer")) };
  } catch {
    return { ip: null, userAgent: null, route: null };
  }
}

type Row = Record<string, unknown> & { metadata?: Record<string, unknown> | null };

/** Adds what is missing from the payload; never replaces what the writer set. */
export function enrichAuditRow<T extends Row>(row: T, ctx: AuditRequestContext): T {
  const metadata: Record<string, unknown> = { ...(row.metadata ?? {}) };
  if (ctx.route && metadata.route == null) metadata.route = ctx.route;
  if (ctx.ip && metadata.ip_address == null) metadata.ip_address = ctx.ip;
  if (ctx.userAgent && metadata.user_agent == null) metadata.user_agent = ctx.userAgent;
  return { ...row, metadata };
}

export function enrichAuditRows<T extends Row>(rows: T | T[], ctx: AuditRequestContext = currentAuditContext()): T | T[] {
  return Array.isArray(rows) ? rows.map((r) => enrichAuditRow(r, ctx)) : enrichAuditRow(rows, ctx);
}

/** The audit_log table of a client, with every insert enriched. Everything else about the table is untouched. */
export function withAuditContext<B extends object>(table: string, builder: B): B {
  if (table !== "audit_log") return builder;
  return new Proxy(builder, {
    get(target, prop) {
      if (prop === "insert") return (rows: Row | Row[], ...rest: unknown[]) => (target as any).insert(enrichAuditRows(rows), ...rest);
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
