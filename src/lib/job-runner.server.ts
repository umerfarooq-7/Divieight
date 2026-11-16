/**
 * Scheduled jobs: authentication, a timeout, retries, and a dead-letter record.
 *
 * Every scheduled endpoint (/api/public/*-sweep and the rest) goes through runSweep():
 *   - the shared secret is checked in constant time, only from the x-sweep-secret header (never the URL, which ends up in logs), and wrong guesses are rate limited;
 *   - the job runs with a timeout and is retried (the jobs are all safe to run again: each is tested for that), with a pause between attempts;
 *   - a job that still fails is written to job_failures (the dead-letter queue: name, attempts, a short error with no personal data), and the Managers are told.
 *
 * The platform's own function time limit still applies (set maxDuration for the deployment to at least the timeout below): a job killed by the host leaves no
 * failure row, and the logging-health monitor is what notices the silence.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { LIMITS, callerKey, checkRateLimit, tooMany } from "@/lib/rate-limit.server";

type Db = { from: (t: string) => any };

export const JOB_TIMEOUT_MS = 55_000;
export const JOB_ATTEMPTS = 2;
export const JOB_RETRY_PAUSE_MS = 1_500;
/** A secret shorter than this is treated as not configured: an easily guessed secret is no secret. */
export const MIN_SECRET_CHARS = 24;

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time equality (both sides hashed first, so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Null when the caller may run a scheduled job; otherwise the response to send. */
export function authorizeSweep(request: Request, env: Record<string, string | undefined> = process.env): Response | null {
  const secret = env["ESCALATION_SWEEP_SECRET"];
  if (!secret || secret.length < MIN_SECRET_CHARS) return new Response("Scheduled jobs are not configured", { status: 503, headers: { "cache-control": "no-store" } });
  const key = callerKey(request);
  const provided = request.headers.get("x-sweep-secret");
  if (provided && safeEqual(provided, secret)) return null;
  const r = checkRateLimit("sweep-auth", key, LIMITS.sweepAuthFailures);
  return r.ok ? new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } }) : tooMany(r);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs fn with a timeout. The work behind a timed-out promise cannot be cancelled here: the next attempt (or the next night) re-runs it, which is safe because the jobs are idempotent. */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** An error as it may be stored: short, with anything that looks like a secret or an address removed. */
export function safeError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_]{8,}/g, "[key]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[token]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[id]")
    .slice(0, 500);
}

export interface JobOptions {
  timeoutMs?: number;
  attempts?: number;
  pauseMs?: number;
}

/** Runs a job with a timeout and retries. Resolves with its result, or records the failure in job_failures and rejects. */
export async function runJob<T>(db: Db, name: string, fn: () => Promise<T>, o: JobOptions = {}): Promise<T> {
  const attempts = o.attempts ?? JOB_ATTEMPTS;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(fn, o.timeoutMs ?? JOB_TIMEOUT_MS, name);
    } catch (e) {
      last = e;
      if (attempt < attempts) await sleep(o.pauseMs ?? JOB_RETRY_PAUSE_MS);
    }
  }
  await recordJobFailure(db, name, attempts, last);
  throw last;
}

/** The dead-letter record, and a notice to the Managers (once per job per day). Never throws: reporting a failure must not hide it. */
export async function recordJobFailure(db: Db, name: string, attempts: number, error: unknown, now: Date = new Date()) {
  const message = safeError(error);
  try {
    await db.from("job_failures").insert({ job_name: name, attempts, error: message, failed_at: now.toISOString() });
  } catch {
    /* the table may not exist yet (job-runner.sql): the response still says the job failed */
  }
  try {
    await db.from("audit_log").insert({ actor_id: null, actor_type: "system", action_type: "job.failed", entity_type: "scheduled_job", entity_id: name, metadata: { job: name, attempts, error: message } });
    const { adminRecipients, deliver } = await import("@/lib/authorization.notify.server");
    for (const admin of await adminRecipients(db as never)) {
      await deliver(db as never, admin, { subject: `Scheduled job failed: ${name}`, message: `The scheduled job "${name}" failed after ${attempts} attempts and was recorded in the dead-letter queue. ${message}`, link: "/admin/launch-readiness", type: "job_failure", dedupeKey: `job_failed:${name}:${now.toISOString().slice(0, 10)}:${admin.authUserId}` });
    }
  } catch {
    /* best effort */
  }
}

/** The whole of a scheduled endpoint: authenticate, run with a timeout and retries, answer with the job's result as JSON. */
export async function runSweep(request: Request, name: string, job: (db: Db) => Promise<unknown>, o: JobOptions = {}): Promise<Response> {
  const denied = authorizeSweep(request);
  if (denied) return denied;
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  const db = supabaseAdmin as unknown as Db;
  try {
    const result = await runJob(db, name, () => job(db), o);
    return new Response(JSON.stringify(result ?? { ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return new Response(JSON.stringify({ error: "The job failed and was recorded.", job: name }), { status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
}
