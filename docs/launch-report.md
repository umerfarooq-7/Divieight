# Launch report: final hardening

**No penetration test and no compliance certification (SOC 2, PCI, ISO 27001 or any other) has been performed.** This report describes what the developers built, tested and reviewed. `docs/soc2-readiness.md` is a readiness self-assessment, not an audit.

No features were changed. Behaviour that did change: scheduled-job endpoints now need the shared secret (the public key no longer works), public endpoints are rate-limited, private-file links live 10 minutes, every response carries security headers, and in the declared production environment the app refuses to serve on simulated adapters.

## Status of each item

| # | Item | Status | Where |
|---|---|---|---|
| 1 | RLS audit and cross-property / cross-role tests | **DONE** (limit: tables whose base schema is not in the repository cannot be built in the test) | docs/rls-audit.md, tests/rls-isolation.test.ts |
| 2 | No secrets in repo or history | **FIXED** in the tree; **GAP** in history: the W-9 key in commit `dd10582` is compromised and cannot be removed from history; rotation runbook, script and key versioning built | docs/security-hardening.md, scripts/ |
| 2 | Keys per environment | **DONE** as a documented rule and a production switch; separate projects still have to be created | docs/operations.md |
| 3 | Input validation | **DONE** for declaration, **GAP** for a strictness review of each of the 339 validators | |
| 3 | Rate limits on public endpoints | **FIXED** for scheduled jobs, attribution links, public reads, the webhook; **GAP:** per-instance only; login/registration limits are Supabase Auth's to configure | rate-limit.server.ts |
| 3 | CSRF / CORS | **DONE** (reviewed; bearer-token auth, no CORS opened) | security-hardening.md |
| 3 | Upload limits, signed-URL expiry | **FIXED**: bucket limits (SQL), 10-minute links; **GAP:** friendly client-side check wired into 2 of ~15 uploaders | storage-hardening.sql, upload-rules.ts |
| 4 | npm audit | **FIXED** critical + all high but one; **GAP:** zod (high) needs a breaking 3 -> 4 upgrade | security-hardening.md |
| 5 | Security headers | **FIXED** (CSP with `'unsafe-inline'`, HSTS, nosniff, frame deny, referrer, permissions) | security-headers.ts |
| 5 | Cookie flags | **FIXED** (`Secure` added); the session is in localStorage, not a cookie | |
| 5 | Logging with no PII/TINs/tokens | **FIXED** (two leaks) and guarded by a test | tests/hardening.test.ts |
| 6 | Indexes | **FIXED** | performance-indexes.sql |
| 6 | EXPLAIN on the 20 slowest queries | **GAP:** 10 representative queries checked for index use on empty tables; the real slowest 20 need production data | docs/performance-explain.md |
| 6 | Paginate every list | **GAP:** not done; Supabase's 1,000-row cap silently truncates large reads (ledger, bank feed, audit viewer) | docs/performance.md |
| 7 | Load test script and report | **DONE** for public pages (k6 + a node runner, results recorded); **GAP:** signed-in flows not load-tested | scripts/, docs/load-test.md |
| 7 | Jobs: idempotent, timeouts, retries, dead letter | **FIXED** (55 s timeout, one retry, `job_failures`, Manager notice); idempotency double-run tested for the Audit Vault and KYO jobs, others rely on dedupe keys | job-runner.server.ts, job-runner.sql |
| 8 | Dev / staging / prod separation | **DONE** as documentation and a production switch; environments still to be created | docs/operations.md |
| 8 | Migrations on a fresh DB | **GAP:** they do not all apply on an empty database (base tables missing); the test proves this and says exactly which; fix is one committed schema dump | tests/migrations-fresh-db.test.ts |
| 8 | Backups and restore test | **GAP:** documented, never rehearsed | operations.md |
| 8 | Error monitoring, uptime alerts | **GAP:** not connected; what to connect is documented | operations.md |
| 8 | Rollback plan, pre-launch checklist | **DONE** | operations.md, pre-launch-checklist.md |
| 9 | Production refuses simulated adapters unless overridden | **DONE** (tested, and run live: 503 with `APP_ENV=production`, 200 with the override) | runtime-config.ts, server.ts |
| 9 | Launch readiness page lists every simulated/placeholder item | **DONE** (32 items, 9 added) | launch-readiness.ts |
| 10 | This report | **DONE** | |

## Production-ready, simulated, and needing others

**Production-ready (built and tested, still subject to the open gaps above):** the ledger and bookkeeping, capital accounts and statements, voting and governance rules, document access stages and signed-document hashes, versioned Terms and Conditions, the append-only Audit Vault with hash chain and alerts, Know Your Owner retention (never deletes by itself), role-based access and row-level security, encryption of tax identifiers with key versions, scheduled jobs with authentication, retries and a dead-letter queue.

**Simulated or test-mode (the app refuses to serve in production on these unless overridden):** liveness vendor, sanctions vendor, title and escrow (Qualia), ACH disbursements, bank feed (Plaid sandbox or simulated), Stripe (test key; the webhook is not built).

**Needs the client, counsel, the CPA or a vendor:**
- *Client:* the real insurance coverage minimums, governance thresholds, distribution reserve, Learning Library content, the choice of liveness and sanctions vendors, domain and environments.
- *Counsel:* every customer-facing legal text listed in the checklist, Operating Agreement clauses 4.4 and 6.2, joint interest, STR treatment, retention periods and wording, the OA-override assumptions.
- *CPA:* Year-End packet JSON against Lacerte / ProConnect, 1099-NEC filing route, statement holiday calendar, usage-adjusted allocation formula.
- *Vendors:* an independent penetration test; real adapters (Plaid production, Qualia, a liveness vendor, a sanctions vendor, an ACH provider); error monitoring and uptime service.

## What the developers verified

All tests pass (`npx vitest run`), `npx tsc --noEmit` is clean, the production build succeeds. New tests: `hardening.test.ts` (production guard, headers, rate limits, job authentication and dead letter, upload rules, log hygiene, secrets guard), `hardening-db.test.ts` (dead-letter table, indexes, EXPLAIN), `key-rotation.test.ts`, plus `rls-isolation.test.ts` and `migrations-fresh-db.test.ts` from earlier in this pass. The PGlite-based tests skip when PGlite is not installed (`npm install --no-save @electric-sql/pglite`).
