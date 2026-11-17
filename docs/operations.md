# Operations: environments, migrations, jobs, backups, monitoring, rollback

## Environments

| | Development | Staging | Production |
|---|---|---|---|
| Supabase project | one per developer, or a shared dev project | its own project | its own project |
| Stripe | test keys | test keys | live keys (after one real payment is rehearsed) |
| Encryption keys (`W9_TIN_ENCRYPTION_KEY*`) | any throwaway | its own | its own, generated once, stored only in Vercel |
| `APP_ENV` | unset | `staging` | `production` |
| `ESCALATION_SWEEP_SECRET` | unset (jobs refuse to run) | its own, 24+ chars | its own, 24+ chars |
| Vendors (liveness, sanctions, Plaid, Qualia, ACH) | simulated / sandbox | simulated / sandbox | real. **The app refuses to serve in production while any is simulated** |

Production safety switch: `src/lib/runtime-config.ts`, enforced in `src/server.ts`. With `APP_ENV=production` (only; the older `IS_PRODUCTION` flag just adds warnings and never blocks) the server answers **503** to every request if
any of these is simulated or in test mode: liveness vendor, sanctions vendor, bank feed (no Plaid credentials, or `PLAID_ENV` not `production`), ACH disbursement, title and escrow (no `QUALIA_API_URL`/`QUALIA_API_TOKEN`), Stripe (key not `sk_live_`).
`ALLOW_SIMULATED_ADAPTERS=true` overrides on purpose (it logs a warning naming each adapter). Without `APP_ENV=production` nothing is refused, so dev, staging and the current
demo deployment are unaffected. It is deliberately *not* keyed on `VERCEL_ENV`: a Vercel "production" deployment can still be a demo.
**Today the ACH rail and both vendors are simulated, so a real launch needs the override or the real adapters.** The admin Launch readiness page lists every item.

## Migrations

The SQL files at the repository root and in `supabase/migrations/` are run by hand in the Supabase SQL editor (each header says what it needs first and is safe to re-run).
`tests/migrations-fresh-db.test.ts` applies them all to an empty Postgres: every checked-in migration applies in order, and the root scripts apply to a fixed point.
**Result: they do NOT all apply on an empty database**, because some base tables (agents, brokers, pods, platform_settings, authorization_requests, ...) were created in the Supabase
project and never checked in. Fix: `supabase db dump --schema-only > schema-baseline.sql` from production, commit it; the test applies it first and then requires every script to apply. Until then a
staging or disaster-recovery database must be built by cloning production's schema, not from the repository.

Order for a real database: baseline, then `supabase/migrations/*` by name, then the root scripts as their headers say, then **last**: `job-runner.sql`, `storage-hardening.sql`, `performance-indexes.sql`, then `cron-sweeps.sql` with the real secret.

## Scheduled jobs

`cron-sweeps.sql` (pg_cron + pg_net) calls each endpoint with the `x-sweep-secret` header. Replace `<SWEEP_SECRET>` with the value of `ESCALATION_SWEEP_SECRET` (24+ characters) and re-run it.
Every endpoint runs through `runSweep` (`src/lib/job-runner.server.ts`): authenticate, time limit (55 s), one retry, and on final failure a row in `job_failures` (the dead-letter table: server-only, append-only) plus an audit entry and a notice to the Managers (once a day per job).
Jobs are written to be safe to run twice (dedupe keys and unique indexes on what they create; the Audit Vault and Know Your Owner jobs are tested for a double run). **Gap:** a per-job double-run test exists only for those; the rest rely on their dedupe keys.
Look at failures: `SELECT * FROM job_failures WHERE resolved_at IS NULL ORDER BY failed_at DESC;` and mark one handled with `UPDATE job_failures SET resolved_at = now() WHERE id = ...`.

## Backups and restore

- Supabase: enable **Point-in-Time Recovery** (paid plans) or at least daily backups on the production project; keep 7+ days. Storage buckets are not in database backups: export them separately (the Supabase CLI or a scheduled copy of the private buckets).
- The audit log hash chain and the nightly verification (`/api/public/audit-vault-sweep`) detect tampering after a restore; run it right after.
- **Restore drill (to do before launch, record the date in Launch readiness):** restore the latest backup into a scratch Supabase project, run `supabase/migrations` checks, sign in with a test account, open a property ledger and a document, run the Audit Vault verification, then delete the scratch project. **This has not been done.**

## Monitoring

Not yet connected (listed in Launch readiness). Minimum before launch:

1. Uptime check on `https://<site>/` and one API route every minute (UptimeRobot, Better Stack, or Vercel's own), alerting a shared mailbox.
2. Error monitoring (Sentry or Vercel Observability) on server errors; `src/lib/error-capture.ts` is the hook point.
3. Supabase: alert on database CPU, connections, storage and auth error rates.
4. The in-app signals already built: `job_failures`, Suspicious Activity Alerts, the Audit Vault verification result.

## Rollback plan

- **App:** Vercel keeps every deployment. Promote the previous deployment (Deployments > the last good one > Promote to Production), or `git revert <sha>` and push (do not rewrite history: the repo is connected to Lovable).
- **Database:** the SQL is additive and re-runnable; there is no down-migration. A bad change is fixed forward with a new script. For data damage, use point-in-time recovery to a moment before the change into a scratch project, then copy back the affected rows.
- **Keys:** a rotation is reversible until the old key is removed (keep it until the re-seal script reports 0 values left).
- **Cron:** disable all jobs with `SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'divieight-%';` and re-run `cron-sweeps.sql` to restore them.
