# Security hardening

What was reviewed, what was changed, and what is still open. **No penetration test, SOC 2 audit or other compliance certification has been performed.** Everything here was
checked by the developers with automated tests and manual review. See [launch-report.md](launch-report.md) for the whole picture.

## 1. Row-level security

`docs/rls-audit.md` lists every table, whether RLS is on, and every policy; `docs/rls-policies.json` is the snapshot the test compares against.
`tests/rls-isolation.test.ts` builds the real schema in Postgres (PGlite) and checks, as each role (anonymous visitor, stranger, owner of A, owner of B, seller of A, seller
of B, Manager):

- documents, reports, authorizations, statements, ledger, inquiries, votes, notifications: a person reads only their own property's and their own rows;
- nobody writes another property's or person's rows;
- the anonymous grants, the "anyone" policies and the browser's write grants are exactly the reviewed lists (a new one fails the test until reviewed).

Limit: tables whose base schema was created in Supabase and never checked in (agents, brokers, pods, authorization_requests and a few more) cannot be built in the test. Run
the queries at the top of `docs/rls-audit.md` against production for those, or check in `schema-baseline.sql` (see operations.md).

## 2. Secrets and keys

- `node scripts/secret-scan.mjs --history` scans the working tree and every added line in git history, printing a masked sample (never the value).
- Result: the working tree is clean. **History contains one real secret: the W-9 encryption key, committed in `.env` (commit `dd10582`).** History cannot be rewritten (the
  repository is connected to Lovable), so the key is treated as **compromised** and must be rotated before any real tax data is stored (runbook below). The line was removed
  from `.env`; `tests/hardening.test.ts` fails if a tracked `.env*` file ever holds a non-public value.
- Public values (Supabase URL and publishable key, Stripe publishable key) are expected in a browser app and are listed, not failed.
- Keys per environment: dev, staging and production each have their own Supabase project, Stripe keys and encryption keys (operations.md). The key is never shared between them.

### Key rotation runbook (W-9 / TIN / influencer payee / bank item encryption)

Values are AES-256-GCM, bound to their row (a value copied to another row does not decrypt), and carry a `key_version`.

1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. In Vercel (Production), add `W9_TIN_ENCRYPTION_KEY_V2=<new key>` and `PII_KEY_VERSION=2`. Keep the old `W9_TIN_ENCRYPTION_KEY` for now. Redeploy: new values are sealed with v2, old ones still open with v1.
3. Dry run: `node scripts/rotate-pii-keys.mjs`. Re-seal: `node scripts/rotate-pii-keys.mjs --apply` (needs the Supabase URL and the service-role key in the environment; prints no key or value; verifies each result decrypts before writing).
4. When it reports 0 values left on version 1, delete `W9_TIN_ENCRYPTION_KEY` from the environment. The compromised key is now useless.
5. Record the date in Launch readiness (W-9 encryption key -> Done).

If no real tax data has been stored yet, the shortcut is to set a brand-new `W9_TIN_ENCRYPTION_KEY` and discard any test values. `tests/key-rotation.test.ts` proves the script and the server agree on the format.

## 3. Public endpoints

| Surface | Protection |
|---|---|
| 31 scheduled-job endpoints (`/api/public/*-sweep` and the like) | Shared secret in the `x-sweep-secret` header only (24+ characters, constant-time compare). Not configured -> 503 (closed). The publishable key and `?secret=` are no longer accepted. Wrong guesses are rate-limited (10/min per address, then 429). |
| Attribution links `/a/<token>` and `/r/<token>` | 30/min per address |
| Public reads (properties, media URLs, standard-rules check) | 120/min per address |
| Provider webhook (`/api/public/title-escrow/<provider>`) | 300/min per address, 1 MB body cap, signature check |
| Registration, login, OTP-like flows | Handled by Supabase Auth (its own rate limits and email throttling). Configure them in the Supabase dashboard (Auth > Rate limits) and enable CAPTCHA there. **Not changed by this app.** |
| Invite and reminder emails | Sent only by signed-in server functions and by the scheduled jobs; each has a dedupe key so a repeat does not re-send. |

**Limit of the rate limiter:** counters live in one server instance's memory. On Vercel several instances run at once, so a determined attacker can spread across them. It stops a
script hammering one endpoint; it is not a firewall. Before launch add Vercel WAF rate-limit rules (or a shared store such as Upstash Redis) for `/api/*`, `/login` and `/signup`.

### Input validation

Every server function declares an input validator (`.inputValidator`, 339 of them across 85 server modules), and the database enforces its own CHECK constraints and foreign keys behind them. The validators were not individually re-audited in this pass: a review of each one's strictness (lengths, formats, array sizes) is a remaining item.

### CSRF and CORS

- **CSRF:** the app authenticates with a bearer token (Supabase session, sent in the `Authorization` header by the client), not a cookie, so a foreign site cannot make the browser send credentials. Cookies that exist (sidebar state, attribution) carry no authority; they are `SameSite=Lax` and now `Secure` over HTTPS. Scheduled and webhook endpoints need a secret or signature that a browser never holds.
- **CORS:** the app sends no `Access-Control-Allow-*` headers, so browsers refuse cross-origin reads. Supabase's own API CORS is managed by Supabase. Nothing needs to be opened.

### Uploads

- Every bucket has a size limit and an allowed-types list, and the private ones are forced private: `storage-hardening.sql` (the enforcement; a browser cannot skip it).
- `src/lib/upload-rules.ts` checks size, type and that the extension matches the type before upload, to give a clear message. **Wired into** the agent E&O and broker tax-form uploads. **GAP:** the other client uploaders (identity pages, liveness, ledger receipts, data room, listing media) rely on the bucket limits alone and still need the friendly check.
- Signed URLs for private files (property documents, receipts, executed agreements, due-diligence files, reports, retention documents) expire in 10 minutes or less (a test checks the code). Listing photos stay at 1 hour: `property-media` is a public bucket by design (public listing photos).

## 4. Dependencies

`npm audit fix` (no `--force`) fixed the critical (shell-quote) and every high advisory except one. **Open: zod (high).** The app uses zod 3; the fix is zod 4, a breaking upgrade that touches
validation across the app. It is a memory-exhaustion risk on very large inputs; request body limits reduce it. Do it as its own change with its own tests (Launch readiness lists it).
`bun.lock` was not regenerated (bun is not installed here); regenerate it with `bun install` if Lovable's build uses it.

## 5. Headers, cookies, logging

- `src/lib/security-headers.ts`, applied in `src/server.ts` to every response: Content-Security-Policy, HSTS (2 years), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy, COOP. The CSP names only the project's own Supabase, Stripe, Plaid, YouTube, Leaflet (unpkg), geocoding and IP lookups the app uses; it forbids framing, plugins, foreign form posts. **Weakness:** it allows `'unsafe-inline'` scripts and styles because the server-rendered app injects inline bootstrap code; a nonce-based CSP is the follow-up. Checked in a browser against the production build: the home page loads all stylesheets with no CSP violations.
- Session: Supabase stores the session in `localStorage` (token in `Authorization`), not in a cookie. That is XSS-sensitive (hence the CSP), and means there is no session cookie to flag. The cookies the app sets are `SameSite=Lax`, `Secure` on HTTPS.
- Logging: `tests/hardening.test.ts` fails if a `console.*` call passes a TIN, token, key, password, email or authorization value. Two real leaks were fixed (recipient email addresses in email-failure logs). Job failures are stored with emails, keys, tokens and SSN-shaped numbers stripped.
