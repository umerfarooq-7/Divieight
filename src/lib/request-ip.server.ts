import { getRequestIP } from "@tanstack/react-start/server";

/**
 * Server-observed client IP for audit records. Prefers the platform's
 * forwarded-for header (Vercel/Cloudflare set it); falls back to the
 * browser-reported value only when the server can't see one.
 */
export function auditIp(clientReported?: string | null): string | null {
  try {
    const ip = getRequestIP({ xForwardedFor: true });
    if (ip) return ip.split(",")[0]!.trim();
  } catch {
    // Outside a request context (e.g. scheduled sweeps).
  }
  return clientReported ?? null;
}
