-- Audit Vault, step 1 of 2: the two read-only roles.
-- Run in the Supabase SQL editor FIRST, on its own, then run audit-vault.sql. (A new enum value cannot be used in the transaction that adds it, which is why
-- this is a separate file. Safe to run again.)
--
--   * compliance_officer: reads the Audit Vault and receives the Suspicious Activity Alerts. Nothing else is granted by this role.
--   * auditor: an external auditor. Reads the Audit Vault, the chain checks and the alerts, read-only. Every read is itself logged.
-- Neither role can write, edit or delete anything.

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'compliance_officer';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'auditor';
