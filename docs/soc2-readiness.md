# SOC 2 readiness report: divieight platform

**Status: readiness assessment. This is not a SOC 2 report, an attestation or a certification, and nothing here should be described to anyone as one.**
A SOC 2 report is issued by an independent CPA firm after it examines the controls over a period of time. This document lists what the platform's code and database
enforce today, where the evidence is, and what is still missing, so that an auditor's first conversation starts from facts.

Prepared with the Audit Vault hardening (Month 6). Scope: the application in this repository (TanStack Start on Vercel, Supabase Postgres and Storage, Stripe).
Everything that runs outside this repository (Supabase and Vercel settings, people, policies) is listed as a gap to be confirmed by the operator, not assumed.

Trust Services Criteria considered: Security (all of CC1 to CC9), with notes on Availability and Confidentiality. Processing Integrity and Privacy are out of scope here.

---

## 1. Controls implemented

Each control names the evidence: the file that implements it and the test that proves it. Tests run in CI order with `npm test` (`vitest`).

### 1.1 Logging and monitoring (CC7.2, CC7.3)

| Control | How it works | Evidence |
|---|---|---|
| Append-only Audit Vault | `UPDATE`, `DELETE` and `TRUNCATE` on `audit_log` are revoked from every role and also refused by trigger, so they fail for the admin and the service role the app uses. | `audit-vault.sql` section 5. `tests/audit-vault-sql.test.ts`: "update, delete and truncate fail for every role". |
| Who, what, when, where on every row | Actor and acting member, event type and entity, before/after values or hashes, the time in UTC to the millisecond set by the database (a caller cannot back-date), and the address, browser and route. | `audit_log_chain()` in `audit-vault.sql`; `src/lib/audit-context.server.ts` enriches every server write; `src/lib/audit.ts` adds the route to browser writes. Tests: "a new row records who, what, when…", "a caller cannot back-date a row". |
| Hash chain | Each row carries `seq`, `prev_hash` and `row_hash` (SHA-256 over the row and the previous hash). Rows that existed before were chained once, in order, at install. | `audit_row_hash`, `audit_log_chain` in `audit-vault.sql`. Test: "chains the rows that were already there". |
| Tamper detection | `audit_verify_chain()` finds an edited row, a removed row, a re-hashed row (the next link breaks) and rows cut from the end (the last good checkpoint is the witness). | Tests: "the hash chain detects tampering" (six cases, on a real Postgres). |
| Nightly verification and alert | A scheduled job recomputes the chain, stores a checkpoint, and raises a critical Suspicious Activity Alert on a break. | `src/routes/api.public.audit-vault-sweep.ts`, `runAuditVaultSweep` in `src/lib/audit-vault.server.ts`, `cron-sweeps.sql`. Tests: "the nightly verification of the hash chain". |
| No secrets in logs | TINs, bank and routing numbers, declaration answers, passwords, tokens and ciphertext are redacted by the database before a row is stored (and any SSN/EIN-shaped value, whatever its key). A TIN is never in an audit payload. | `audit_redact` in `audit-vault.sql`; mirrored in `src/lib/audit-vault.ts`. Tests: "never stores a TIN, a bank number…" and "the application's rule and the database's rule name the same keys". |
| Completeness safety net | Every change to a list of critical tables (registration, payments, reservations, the hard lock, signatures, authorizations, earnest money, closing funds, saga, votes, resale, expenses, capital calls, distributions, journal, statements, CPA, roles, settings, and the cap table and commission data) writes a row whatever code made it, with the table, the row, the columns that changed and hashes of the row before and after. | `audit_row_change()` and the table list in `audit-vault.sql`. Tests: "the safety net on the critical tables". |
| Completeness inventory | Every state-changing event, whether it writes to the Audit Vault, and where. A test fails if a listed action stops being written, if a listed table loses its trigger, or if an event has neither. | `src/lib/audit-inventory.ts`; `tests/audit-vault.test.ts` ("completeness inventory", "a registered critical action that produces no audit row fails the test"). The screen `/audit-vault` shows the inventory. |
| Suspicious Activity Alerts | The Compliance Officer is told (in-app and by email, once per alert) when commission splits, referral shares, ownership allocations or the cap table change outside the standardized code paths (directly in the database, or through the application with no matching application record), when a TIN is decrypted outside the business rules, when one person decrypts an unusual number of TINs, and when the chain breaks. With no Compliance Officer named, every Manager is told. | `audit-vault.sql` (alerts table and trigger), `src/lib/audit-vault.server.ts`, `src/lib/pii-access.server.ts`. Tests: "Suspicious Activity Alerts" (two describe blocks). |
| Operational silence detection | A source that stops logging for longer than its cadence raises an admin alert. | `src/lib/logging-health.ts` (existing). |

### 1.2 Access control (CC6.1, CC6.2, CC6.3)

| Control | How it works | Evidence |
|---|---|---|
| Role-based access | Server functions check the role in the database (`has_role`) before acting: Manager, founder, tax vault, designated CPA (per LLC), Compliance Officer, auditor. A refusal is a 403. | `src/lib/*.functions.ts`; tests such as `tests/analytics.test.ts` ("access: admins and the founder only"). |
| Read-only access to the Audit Vault, itself logged | Only the Manager, the Compliance Officer and auditors read it. There is no direct `SELECT` on the table for members, visitors or the API at all. The door is `read_audit_vault()` (database) or `getAuditVault` (app); each writes an `audit.vault_accessed` row before returning anything, and refuses if that row cannot be written. Auditors cannot acknowledge alerts or run checks. | `audit-vault.sql` section 8; `src/lib/audit-vault.server.ts`. Tests: "access to the Audit Vault is read-only and is itself logged"; "reading the Audit Vault is read-only and logged" (database). |
| Least privilege on the log | The browser can still log the signed-in person's own action (row-level security: `actor_id = auth.uid()`); it cannot read, change or delete. | Test: "no member or visitor can read the table directly…". |
| Sensitive data access is reasoned and audited | A TIN is shown only through three paths (tax export, tax vault, designated CPA), each writing its audit row first (nothing is decrypted if that fails), each requiring a reason, each scoped (the tax-vault permission; the CPA's own LLC). | `src/lib/w9.server.ts`; `tests/audit-vault.test.ts` ("a TIN decryption writes its audit row first, and the row never holds the TIN"). |
| Admin and founder separation | Founder-only settings and dashboard; admin analytics and reports. | `src/lib/governance-config.server.ts`, `src/lib/analytics.server.ts`. |

### 1.3 Change management (CC8.1)

| Control | How it works | Evidence |
|---|---|---|
| Source control with review history | All changes are commits on the connected branch; history is never rewritten (stated in `AGENTS.md`). | Git history; `AGENTS.md`. |
| Automated tests gate every change | The suite (1,700+ tests, including real-Postgres tests of the SQL) is run before each push. | `tests/`. |
| Immutable configuration history | Governance settings, standards versions, Terms and Conditions versions and launch readiness changes are audited; Terms versions are never edited. | `tc-versions.sql`; `src/lib/governance-config.server.ts`; inventory rows under "Configuration". |
| Database schema changes are explicit, idempotent scripts | `*.sql` files, run by the operator in the Supabase editor, safe to re-run. | Repository root. |

### 1.4 Encryption (CC6.1, CC6.7)

| Control | How it works | Evidence |
|---|---|---|
| TINs encrypted at rest at the application layer | AES-256-GCM with the row's identity bound in as associated data (a ciphertext moved to another row will not decrypt); key in `W9_TIN_ENCRYPTION_KEY`, versioned for rotation; no plaintext fallback. | `src/lib/pii-crypto.server.ts`. |
| TINs never in plain text elsewhere | Last four digits only in tables and logs; full values only in the encrypted secrets tables and, briefly, in the response of an audited view. | Redaction tests above. |
| Private storage for tax and packet files | Private buckets, signed URLs, every download logged. | `src/lib/year-end-packet.server.ts`, `src/lib/tax-forms.server.ts`. |

### 1.5 Data integrity and records (supporting CC7 and availability of evidence)

Executed documents are pinned to what was signed and never rewritten (`executed_document_texts`, `document-access.sql`); signed acknowledgments, re-trigger records, posture records,
Terms versions, notices and acceptances are immutable by trigger; the closing saga records every step and sends failures to a dead-letter queue.

---

## 2. Gaps and residual risks

Be plain about these with an auditor. Items marked **Operator** need someone to look at a system outside this repository.

### 2.1 Technical gaps in this repository

1. **A database superuser can disable a trigger.** Append-only is enforced by privilege and by trigger. Someone connected as the database owner (`postgres`) can `ALTER TABLE … DISABLE TRIGGER` and edit a row. The hash chain is what makes that detectable (the nightly check and its checkpoints), not what prevents it. Mitigation to consider: restrict who holds the owner credential, log DDL with the `pgaudit` extension, ship `audit_log` to write-once external storage.
2. **The browser can write its own log rows.** The signed-in person's own `INSERT` into `audit_log` is allowed so client-side logging keeps working (`actor_id = auth.uid()`). A person could write a row, as themselves, with any action name. They cannot read, change or delete rows, and cannot write as someone else. Mitigation: move the remaining browser-side logging (`src/lib/audit.ts`, used by registration, identity, the listing agreement and similar) to server functions, then remove the insert grant from `authenticated`.
3. **The row-level safety net fails open.** If `audit_row_change()` itself raises, it logs a warning and lets the business write through, so an audit-code fault cannot take the platform down. The application's own audit rows and the chain are unaffected. A silent fault there would leave a gap in the database-level record; the logging-health monitor would not see it because other rows keep arriving.
4. **A change through the application is judged "unreconciled" by matching, not by proof.** For protected tables written through the application, the nightly job looks for an application audit row of the right kind, near in time, about the same property or record. A code path that changes protected data and also writes a plausible audit row would be accounted for. Direct database changes are alerted immediately, without matching.
5. **The reconciliation allow-lists are a judgement.** `PROTECTED_TABLES` in `src/lib/audit-inventory.ts` says which action prefixes account for a change to each protected table. Review them when a new code path writes protected data.
6. **Legacy rows were rewritten once.** Installing the hardening redacted sensitive values in old rows and gave them their chain numbers and hashes (the only time the log is ever modified, under a one-time switch that cannot touch a numbered row). Before that moment the chain cannot attest to history.
7. **One global lock serialises log writes.** The chain needs one order, so inserts take an advisory lock. Fine at the current volume; revisit at high write rates.
8. **Reads through a direct database role are not logged.** `audit_reader` exists for break-glass use by an auditor given a direct connection; a `SELECT` cannot fire a trigger. Prefer `read_audit_vault()` or the `/audit-vault` screen, which log every read.
9. **The nightly check scans the whole log.** Correct, and cheap now; it will need an incremental mode with periodic full runs as the log grows.
10. **Event coverage depends on the list.** The inventory test proves every listed event is audited, and the table safety net catches changes to listed tables. A new table or a new kind of action must be added to the inventory and to the table list; nothing detects a state change on a table nobody listed.
11. **No automated dependency or secret scanning** is configured in this repository (CC7.1). Add Dependabot or equivalent and secret scanning on the repository.
12. **No rate limiting or abuse detection at the application layer** beyond the TIN-decryption burst alert (CC6.6).

### 2.2 Operator items (outside the repository)

| Area | What to confirm or build | Criteria |
|---|---|---|
| Backups and recovery | Supabase plan includes daily backups and point-in-time recovery; retention period matches policy; **a restore has been tested** and the result recorded. The Audit Vault must be restored with the chain intact. | A1.2, A1.3 |
| Encryption at rest and in transit | Confirm Supabase (disk encryption) and Vercel/Stripe settings; confirm TLS only, HSTS, and no plain HTTP endpoints. Supabase and Vercel provide TLS by default; verify, do not assume. | CC6.1, CC6.7 |
| Key management | Rotate `W9_TIN_ENCRYPTION_KEY` (rotation is supported by key version; none has been performed), document who can read it, store it in the secret manager only. | CC6.1 |
| Access reviews | Quarterly review of who holds the Manager, founder, tax vault, Compliance Officer and auditor roles, and of Supabase and Vercel project members; remove leavers the same day. MFA on every administrative account (Supabase, Vercel, GitHub, Stripe). | CC6.2, CC6.3 |
| Named Compliance Officer | Grant the `compliance_officer` role to the person who will receive alerts. Until then alerts go to every Manager. | CC7.3 |
| Incident response | A written plan, an on-call owner, severity levels, a communication template, and a rehearsal (tabletop). The platform now produces the signal (Suspicious Activity Alerts, chain breaks); there is no written procedure for acting on it. | CC7.3, CC7.4, CC7.5 |
| Written policies | Information security, access control, change management, data retention and disposal, vendor management, acceptable use, and a risk assessment. None exist in this repository. | CC1, CC2, CC3 |
| Vendor management | Collect current SOC 2 reports (or equivalents) for Supabase, Vercel, Stripe, Plaid and the email provider, and record their review. | CC9.2 |
| Monitoring and alerting | Route the Vercel and Supabase error and uptime alerts to a monitored channel. | CC7.2 |
| Production change approval | Decide whether a second person must approve a merge to the deployed branch (branch protection), and for SQL run in the Supabase editor. At present the schema scripts are run by one person with no second approval. | CC8.1 |
| Penetration test and vulnerability management | An independent test and a patching cadence. | CC4.1, CC7.1 |
| Retention | Decide how long the Audit Vault is kept. The log is append-only with no deletion path by design; if a retention limit applies, archive by export (the exports are logged) rather than by deletion. | C1.2 |

### 2.3 What changed in this hardening (for the auditor's change record)

Found by the audit of the six months of code (see the inventory screen for the full table):

* Several state changes were audited only in the browser, or not at all: the buyer and seller **enrollment payment** (a closed tab left no record), the **hard lock** and **system lock** themselves, **agent and broker registration**, **admin role grants** and **platform settings**.
* Any signed-in person could read every audit row (the original policy was `USING (true)`), including other people's address and browser. That policy is removed.
* `service_role` held `ALL` privileges on the audit table, so the application's own credential could have edited or deleted rows. Revoked.
* Audit payloads were not checked for sensitive values. The database now redacts them.
* Nothing alerted on a change to commission, referral, ownership or cap table data made outside the application, or on a TIN decrypted outside the three audited paths.
* The existing audit viewer read the table straight from the browser, unlogged. It now reads through the logged door.

---

## 3. Operating the controls

* Run `audit-roles.sql`, then `audit-vault.sql` (once, in that order), then re-run `cron-sweeps.sql` with the real secret to schedule the nightly job.
* Grant `compliance_officer` and `auditor` through `user_roles` (insert the row for the person's user id).
* `/audit-vault` is the screen for all three read roles: chain checks (with "verify now"), alerts (with acknowledgement notes), the log, and the completeness inventory.
* An alert is acknowledged with a note of what was found and done; the acknowledgement is itself logged and cannot be edited.
* **Expected noise:** running a SQL script directly against protected tables (for example resetting test data) is exactly what the alert exists to flag. Acknowledge it with a note.

*Do not describe this platform as SOC 2 compliant or certified. The accurate statement is that it has controls designed against the Security criteria, with the gaps above identified, and that an independent examination has not been performed.*
