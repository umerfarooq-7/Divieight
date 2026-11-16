/**
 * Rate limiting for public endpoints: a sliding window per caller.
 *
 * LIMIT OF THIS DESIGN: the counters live in the memory of one server instance. On a serverless host, several instances run at once, so the effective limit is
 * per instance, and a determined attacker can spread across them. It stops a script hammering one endpoint and bounds the cost of a loop; it is not a substitute for
 * the host's firewall (Vercel WAF rate limiting, or a shared store such as Upstash Redis). See docs/security-hardening.md.
 */

interface Bucket {
  hits: number[];
}
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

export interface Limit {
  /** Requests allowed in the window. */
  limit: number;
  windowMs: number;
}

export interface LimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until a request would be allowed again (0 when ok). */
  retryAfter: number;
}

/** Counts this request against `key` in `name`, and says whether it is within the limit. */
export function checkRateLimit(name: string, key: string, { limit, windowMs }: Limit, now: number = Date.now()): LimitResult {
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, b] of buckets) {
      b.hits = b.hits.filter((t) => now - t < 3_600_000);
      if (b.hits.length === 0) buckets.delete(k);
    }
  }
  const id = `${name}|${key}`;
  const b = buckets.get(id) ?? { hits: [] };
  b.hits = b.hits.filter((t) => now - t < windowMs);
  if (b.hits.length >= limit) {
    buckets.set(id, b);
    return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((b.hits[0]! + windowMs - now) / 1000)) };
  }
  b.hits.push(now);
  buckets.set(id, b);
  return { ok: true, remaining: limit - b.hits.length, retryAfter: 0 };
}

/** For tests. */
export function resetRateLimits() {
  buckets.clear();
  lastSweep = 0;
}

/** The caller's address as the host reports it (the first hop of x-forwarded-for), else a shared bucket: an unknown caller is limited together, not exempt. */
export function callerKey(request: Request | { headers: Headers }): string {
  const fwd = request.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip");
  return ip || "unknown";
}

/** The limits for the public surfaces, in one place. */
export const LIMITS = {
  /** Wrong or missing secret on a scheduled-job endpoint. */
  sweepAuthFailures: { limit: 10, windowMs: 60_000 },
  /** A /a/<token> or /r/<token> attribution link being followed. */
  attributionVisit: { limit: 30, windowMs: 60_000 },
  /** Public, unauthenticated reads (the marketplace, a property page). */
  publicRead: { limit: 120, windowMs: 60_000 },
  /** An inbound provider webhook. */
  webhook: { limit: 300, windowMs: 60_000 },
} as const satisfies Record<string, Limit>;

/** A 429 response for a limit that was exceeded. */
export function tooMany(r: LimitResult): Response {
  return new Response("Too many requests", { status: 429, headers: { "retry-after": String(r.retryAfter), "cache-control": "no-store" } });
}

/**
 * For a public server function: counts the call against the caller's address and throws (with a 429) when it is over the limit. Returns normally otherwise.
 * An unknown caller (no address from the host) shares one bucket.
 */
export async function enforceRateLimit(name: string, limit: Limit): Promise<void> {
  let key = "unknown";
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    key = callerKey(getRequest());
  } catch {
    /* no request context (a script or a test): the shared bucket */
  }
  const r = checkRateLimit(name, key, limit);
  if (r.ok) return;
  try {
    const { setResponseStatus } = await import("@tanstack/react-start/server");
    setResponseStatus(429);
  } catch {
    /* no response to set */
  }
  throw new Error("Too many requests. Try again in a moment.");
}
