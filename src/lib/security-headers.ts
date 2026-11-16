/**
 * Security headers for every response. Applied in src/server.ts so they hold on any host.
 *
 * The CSP allows 'unsafe-inline' for scripts and styles because the server-rendered app injects inline bootstrap scripts and Tailwind/Radix style attributes.
 * That is the known weakness: a nonce-based CSP is the follow-up (see docs/security-hardening.md). Everything else (frames, objects, base, forms, other origins) is locked.
 */
export function buildCsp(env: Record<string, string | undefined> = process.env): string {
  let supabase = "https://*.supabase.co";
  try {
    if (env["SUPABASE_URL"]) supabase = new URL(env["SUPABASE_URL"]).origin;
  } catch {
    /* keep the wildcard */
  }
  const wsSupabase = supabase.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://js.stripe.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `img-src 'self' data: blob: ${supabase} https:`,
    `media-src 'self' blob: ${supabase} https://*.r2.dev`,
    `connect-src 'self' ${supabase} ${wsSupabase} https://api.stripe.com https://*.plaid.com https://api.ipify.org https://nominatim.openstreetmap.org`,
    "frame-src https://js.stripe.com https://hooks.stripe.com https://*.plaid.com https://www.youtube-nocookie.com https://www.youtube.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function securityHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return {
    "content-security-policy": buildCsp(env),
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(self), microphone=(), geolocation=(), payment=(self), usb=(), interest-cohort=()",
    "cross-origin-opener-policy": "same-origin",
  };
}

/** Adds the headers to a response (never overwriting one a route set on purpose). Returns a new Response when the original's headers are immutable. */
export function withSecurityHeaders(response: Response, env: Record<string, string | undefined> = process.env): Response {
  const add = (h: Headers) => {
    for (const [k, v] of Object.entries(securityHeaders(env))) if (!h.has(k)) h.set(k, v);
  };
  try {
    add(response.headers);
    return response;
  } catch {
    const h = new Headers(response.headers);
    add(h);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
  }
}
