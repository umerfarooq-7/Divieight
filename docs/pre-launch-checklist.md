# Pre-launch checklist

Tick every line, with a date and a name, before real members, real money or real tax data. Items marked (client), (counsel), (CPA) or (vendor) cannot be done by the developers.

## Security
- [ ] Rotate the W-9 encryption key; delete the old one (security-hardening.md runbook). The committed key is compromised.
- [ ] `ESCALATION_SWEEP_SECRET` set (24+ chars) in Vercel; `cron-sweeps.sql` re-run with the same value.
- [ ] Run, in this order, after all other SQL: `job-runner.sql`, `storage-hardening.sql`, `performance-indexes.sql`.
- [ ] Supabase Auth: enable CAPTCHA and review rate limits; confirm email confirmation is required; set the site URL and redirect allow-list to the real domain.
- [ ] Vercel WAF rate-limit rules for `/api/*`, `/login`, `/signup` (the app's own limiter is per instance).
- [ ] Independent penetration test (vendor). **None has been performed.**
- [ ] Resolve the zod advisory (zod 4 upgrade) and re-run `npm audit`.
- [ ] Run `node scripts/secret-scan.mjs --history`: the only finding should be the rotated W-9 key.

## Production switches
- [ ] `APP_ENV=production` set. Every adapter real, or `ALLOW_SIMULATED_ADAPTERS=true` set knowingly and written down: liveness, sanctions, Plaid (`PLAID_ENV=production`), ACH, Qualia, Stripe live key + webhook.
- [ ] Stripe webhook built and tested (a fee currently counts only if the buyer returns to the site).
- [ ] One real payment rehearsed end to end, then refunded.

## Data and recovery
- [ ] `schema-baseline.sql` dumped and committed; `npx vitest run tests/migrations-fresh-db.test.ts` shows every script applying.
- [ ] Point-in-time recovery on; a restore drill done into a scratch project and dated.
- [ ] Storage bucket backup scheduled.
- [ ] Uptime and error monitoring connected, with an on-call mailbox.

## Content and legal (counsel / client / CPA)
- [ ] Counsel reviewed: Terms and Conditions, document-access wording, eligibility Standard and Question 5, adverse-action template, retention and deletion wording, Operating Agreement draft clauses 4.4 and 6.2, joint-interest wording, STR treatment (Section 10).
- [ ] Compliance supplied the real insurance coverage minimums.
- [ ] Governance thresholds and the distribution minimum reserve confirmed against the final Operating Agreement.
- [ ] CPA validated the Year-End packet JSON in Lacerte or ProConnect; chose the 1099-NEC filing route; confirmed the statement holiday calendar.
- [ ] Learning Library content supplied and reviewed.
- [ ] Launch readiness page: every item is Done or consciously accepted.

## Day of launch
- [ ] Run the load test against staging (`node scripts/load-test.mjs <staging-url>`), and a signed-in one once test accounts exist.
- [ ] Confirm the rollback path (previous Vercel deployment) works.
- [ ] After launch: watch `job_failures`, Suspicious Activity Alerts and the Audit Vault verification for 48 hours.
