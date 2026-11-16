/**
 * Launch hardening, the parts that need no database: production guard, security headers, rate limits, scheduled-job authentication and dead-letter, upload rules,
 * log hygiene and the secrets guard.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertProductionReadiness, isProductionRuntime, simulatedAdapters, ProductionReadinessError } from "@/lib/runtime-config";
import { buildCsp, securityHeaders, withSecurityHeaders } from "@/lib/security-headers";
import { checkRateLimit, resetRateLimits, callerKey, LIMITS } from "@/lib/rate-limit.server";
import { authorizeSweep, runJob, safeError, safeEqual, withTimeout } from "@/lib/job-runner.server";
import { MAX_SIGNED_URL_SECONDS, safeUploadPath, uploadProblem } from "@/lib/upload-rules";

const LIVE_ENV = { APP_ENV: "production", STRIPE_SECRET_KEY: "sk_live_" + "abcdefghijklmnop", PLAID_CLIENT_ID: "c", PLAID_SECRET: "s", PLAID_ENV: "production", QUALIA_API_URL: "https://q", QUALIA_API_TOKEN: "t" };

describe("production refuses simulated adapters", () => {
  it("lists every simulated adapter from the environment", () => {
    const keys = simulatedAdapters({}).map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining(["liveness", "sanctions", "bank_feed", "ach_disbursement", "title_escrow", "stripe"]));
  });
  it("a test Stripe key, Plaid sandbox, and missing Qualia credentials are each reported", () => {
    const keys = simulatedAdapters({ STRIPE_SECRET_KEY: "sk_test_x", PLAID_CLIENT_ID: "c", PLAID_SECRET: "s", PLAID_ENV: "sandbox" }).map((a) => a.key);
    expect(keys).toContain("stripe");
    expect(keys).toContain("bank_feed");
    expect(keys).toContain("title_escrow");
  });
  it("the declared production environment throws, and says which adapters", () => {
    expect(() => assertProductionReadiness({ APP_ENV: "production" })).toThrow(ProductionReadinessError);
    expect(() => assertProductionReadiness({ IS_PRODUCTION: "true" })).toThrow(/liveness/);
  });
  it("ALLOW_SIMULATED_ADAPTERS=true overrides on purpose, and still reports what is simulated", () => {
    const sim = assertProductionReadiness({ APP_ENV: "production", ALLOW_SIMULATED_ADAPTERS: "true" });
    expect(sim.length).toBeGreaterThan(0);
  });
  it("anything but the exact word true does not override", () => {
    for (const v of ["1", "yes", "TRUE", ""]) expect(() => assertProductionReadiness({ APP_ENV: "production", ALLOW_SIMULATED_ADAPTERS: v })).toThrow();
  });
  it("development and staging are never refused", () => {
    expect(isProductionRuntime({})).toBe(false);
    expect(() => assertProductionReadiness({})).not.toThrow();
    expect(() => assertProductionReadiness({ APP_ENV: "staging" })).not.toThrow();
  });
  it("the ACH rail and the vendors stay simulated, so production still refuses even with every key set (nothing real exists to run on)", () => {
    expect(() => assertProductionReadiness(LIVE_ENV)).toThrow(/ach_disbursement|liveness|sanctions/);
  });
  it("server.ts runs the gate before serving, and sends the headers on every path", () => {
    const src = readFileSync("src/server.ts", "utf8");
    expect(src).toContain("productionGate");
    expect(src).toContain("assertProductionReadiness");
    expect(src.match(/withSecurityHeaders\(/g)!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("security headers", () => {
  it("sets the full set", () => {
    const h = securityHeaders({ SUPABASE_URL: "https://abc.supabase.co" });
    for (const k of ["content-security-policy", "strict-transport-security", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"]) expect(h[k]).toBeTruthy();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
  });
  it("CSP forbids framing, plugins and foreign form posts, and names only the project's Supabase", () => {
    const csp = buildCsp({ SUPABASE_URL: "https://abc.supabase.co" });
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("https://abc.supabase.co");
    expect(csp).toContain("wss://abc.supabase.co");
    expect(csp).not.toContain("*.supabase.co");
  });
  it("adds headers to a response and keeps one a route set on purpose", () => {
    const r = withSecurityHeaders(new Response("x", { headers: { "x-frame-options": "SAMEORIGIN" } }), {});
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(r.headers.get("strict-transport-security")).toContain("max-age");
  });
  it("works on an immutable response (a fetch result)", () => {
    const immutable = Response.redirect("https://example.com/", 302);
    expect(withSecurityHeaders(immutable, {}).headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("rate limits", () => {
  beforeEach(() => resetRateLimits());
  it("allows the limit, then refuses with a retry time", () => {
    const l = { limit: 3, windowMs: 1000 };
    for (let i = 0; i < 3; i++) expect(checkRateLimit("t", "1.1.1.1", l, 0).ok).toBe(true);
    const r = checkRateLimit("t", "1.1.1.1", l, 10);
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBeGreaterThanOrEqual(1);
  });
  it("is per caller and per name, and frees up after the window", () => {
    const l = { limit: 1, windowMs: 1000 };
    expect(checkRateLimit("a", "x", l, 0).ok).toBe(true);
    expect(checkRateLimit("a", "y", l, 0).ok).toBe(true);
    expect(checkRateLimit("b", "x", l, 0).ok).toBe(true);
    expect(checkRateLimit("a", "x", l, 500).ok).toBe(false);
    expect(checkRateLimit("a", "x", l, 1500).ok).toBe(true);
  });
  it("the caller is the first forwarded address; an unknown caller shares one bucket", () => {
    expect(callerKey(new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } }))).toBe("9.9.9.9");
    expect(callerKey(new Request("http://x"))).toBe("unknown");
  });
  it("the public limits are set", () => {
    expect(LIMITS.attributionVisit.limit).toBeLessThanOrEqual(60);
    expect(LIMITS.sweepAuthFailures.limit).toBeLessThanOrEqual(20);
  });
});

describe("scheduled job authentication", () => {
  const SECRET = "s".repeat(32);
  const req = (headers: Record<string, string> = {}, url = "http://x/api/public/job") => new Request(url, { method: "POST", headers });
  beforeEach(() => resetRateLimits());
  it("is not configured without a long secret (503), never open", () => {
    expect(authorizeSweep(req({ "x-sweep-secret": "anything" }), {})!.status).toBe(503);
    expect(authorizeSweep(req({ "x-sweep-secret": "short" }), { ESCALATION_SWEEP_SECRET: "short" })!.status).toBe(503);
  });
  it("accepts the secret in the header only", () => {
    expect(authorizeSweep(req({ "x-sweep-secret": SECRET }), { ESCALATION_SWEEP_SECRET: SECRET })).toBeNull();
    expect(authorizeSweep(req({}, `http://x/api/public/job?secret=${SECRET}`), { ESCALATION_SWEEP_SECRET: SECRET })!.status).toBe(401);
  });
  it("the publishable (anon) key is not a credential", () => {
    expect(authorizeSweep(req({ apikey: "eyJhbGciOi.public.anon", authorization: "Bearer eyJhbGciOi.public.anon" }), { ESCALATION_SWEEP_SECRET: SECRET })!.status).toBe(401);
  });
  it("repeated wrong guesses are cut off with a 429", () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = authorizeSweep(req({ "x-sweep-secret": "wrong" + i, "x-forwarded-for": "5.5.5.5" }), { ESCALATION_SWEEP_SECRET: SECRET })!.status;
    expect(last).toBe(429);
  });
  it("compares in constant time on equal digests only", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
  it("every scheduled route is wrapped in runSweep and none reads the key from the URL", () => {
    const dir = "src/routes";
    const sweeps = readdirSync(dir).filter((f) => /^api\.public\..*(sweep|escalation|retry|refresh|maintenance|reminders|check|health)/.test(f) && !f.includes("standard-rules"));
    expect(sweeps.length).toBeGreaterThan(25);
    for (const f of sweeps) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).toContain("runSweep(");
      expect(src, f).not.toMatch(/searchParams\.get\(["']secret["']\)/);
    }
    expect(readFileSync("cron-sweeps.sql", "utf8")).not.toMatch(/apikey|eyJ[A-Za-z0-9_-]{20,}/);
  });
});

describe("jobs: timeout, retry, dead letter", () => {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const db = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push({ table, row });
        return { error: null };
      },
      select: () => ({ eq: () => ({ in: async () => ({ data: [] }), then: (f: (v: unknown) => unknown) => f({ data: [] }) }), in: async () => ({ data: [] }) }),
    }),
  };
  beforeEach(() => (inserted.length = 0));
  it("times out a job that hangs", async () => {
    await expect(withTimeout(() => new Promise(() => undefined), 20, "slow")).rejects.toThrow(/timed out/);
  });
  it("retries once and returns the result when the second attempt works", async () => {
    let n = 0;
    const v = await runJob(db as never, "j", async () => (++n < 2 ? Promise.reject(new Error("blip")) : "done"), { pauseMs: 1, attempts: 2 });
    expect(v).toBe("done");
    expect(inserted.filter((i) => i.table === "job_failures")).toHaveLength(0);
  });
  it("a job that keeps failing lands in the dead-letter table, with the error cleaned", async () => {
    await expect(runJob(db as never, "j2", async () => Promise.reject(new Error("failed for pat@example.com with key sk_live_" + "abcdefghijklmnop and 123-45-6789")), { pauseMs: 1, attempts: 2 })).rejects.toThrow();
    const row = inserted.find((i) => i.table === "job_failures")!.row;
    expect(row["job_name"]).toBe("j2");
    expect(row["attempts"]).toBe(2);
    expect(String(row["error"])).not.toMatch(/pat@example|sk_live_|123-45-6789/);
  });
  it("safeError strips tokens", () => {
    expect(safeError(new Error("Bearer eyJhbGciOiJIUzI1" + ".eyJzdWIiOiIxMjM0NTY3" + ".SflKxwRJSMeKKF2QT4fw"))).toContain("[token]");
  });
});

describe("uploads", () => {
  const f = (name: string, type: string, size = 1000) => ({ name, type, size });
  it("accepts a normal file", () => {
    expect(uploadProblem(f("id.pdf", "application/pdf"), "identity")).toBeNull();
    expect(uploadProblem(f("me.JPG", "image/jpeg"), "selfie")).toBeNull();
  });
  it("refuses a too-big, empty, wrong-type or mislabelled file, in plain words", () => {
    expect(uploadProblem(f("a.pdf", "application/pdf", 11 * 1024 * 1024), "identity")).toMatch(/too large/);
    expect(uploadProblem(f("a.pdf", "application/pdf", 0), "identity")).toMatch(/empty/);
    expect(uploadProblem(f("a.exe", "application/x-msdownload"), "document")).toMatch(/not accepted/);
    expect(uploadProblem(f("a.html", "image/png"), "document")).toMatch(/does not match/);
    expect(uploadProblem(f("noext", "image/png"), "document")).toMatch(/does not match/);
    expect(uploadProblem(f("a.pdf", "application/pdf"), "selfie")).toMatch(/not accepted/);
  });
  it("a path cannot climb out of the person's folder", () => {
    const p = safeUploadPath("user-1", "../../etc", "x.p/h\\p", 1);
    expect(p).toBe("user-1/etc-1.php");
    expect(p).not.toContain("..");
  });
  it("signed links for private files live 10 minutes at most", () => {
    expect(MAX_SIGNED_URL_SECONDS).toBeLessThanOrEqual(600);
    const privateBuckets = /from\("(property-documents|ledger-receipts|identity-documents|agent-documents|liveness-selfies)"\)/;
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.(ts|tsx)$/.test(n) ? [join(d, n)] : []));
    for (const file of walk("src")) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/createSignedUrls?\(([^)]*?)(\d+(?:\s*\*\s*\d+)?)\s*[,)]/g)) {
        const near = src.slice(Math.max(0, (m.index ?? 0) - 160), m.index);
        if (!privateBuckets.test(near)) continue;
        const secs = Function(`return ${m[2]}`)() as number;
        expect(secs, `${file}: ${m[0]}`).toBeLessThanOrEqual(600);
      }
    }
  });
  it("the bucket limits are in storage-hardening.sql and every private bucket is forced private", () => {
    const sql = readFileSync("storage-hardening.sql", "utf8");
    for (const b of ["identity-documents", "liveness-selfies", "property-documents", "ledger-receipts", "agent-documents", "statements", "year-end-packets", "packet-pii", "tax-ready"]) {
      expect(sql, b).toMatch(new RegExp(`\\('${b}',\\s+false,`));
    }
    expect(sql).toMatch(/\('property-media',\s+true,/);
  });
});

describe("logs and secrets", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.(ts|tsx)$/.test(n) ? [join(d, n)] : []));
  it("no console call prints a TIN, a token, a key, an email address or a whole request/user object", () => {
    const bad = /console\.(log|info|warn|error|debug)\([^)]*\b(tin|ssn|password|secret|token|apikey|api_key|authorization|serviceRole|accessToken|refreshToken|email|encrypted|plaintext|w9)\b/i;
    const hits: string[] = [];
    for (const file of walk("src")) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        // Words inside a message are not values: only what is passed as an argument is checked.
        const code = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
        if (bad.test(code) && !/\/\/\s*log-ok/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(hits).toEqual([]);
  });
  it("tracked .env files hold only public values", () => {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((f) => /(^|\/)\.env(\..*)?$/.test(f) && !/example|sample/.test(f));
    for (const f of tracked) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\s#]*)/.exec(line);
        if (!m) continue;
        const [, key, value] = m as unknown as [string, string, string];
        if (!value) continue;
        const isPublic = /^(VITE_|NEXT_PUBLIC_)/.test(key) || /^(SUPABASE_URL|SUPABASE_PUBLISHABLE_KEY|SUPABASE_PROJECT_ID)$/.test(key);
        expect(isPublic, `${f}: ${key} is not a public value and must not be committed`).toBe(true);
        if (/KEY|TOKEN/.test(key)) expect(value.startsWith("eyJ") || value.startsWith("pk_") || value.startsWith("sb_publishable_"), `${f}: ${key} must be a publishable key`).toBe(true);
      }
    }
  });
  it("the working tree has no secret (the scanner's own verdict)", () => {
    // Exits 1 (and throws here) when it finds a secret that is not on the reviewed allow-list.
    const out = execFileSync("node", ["scripts/secret-scan.mjs"], { encoding: "utf8" });
    expect(out).toContain("Possible secrets: 0");
  });
});
