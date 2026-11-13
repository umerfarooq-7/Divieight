-- Month 6, Prompt 12: the 'cpa' role value. Run this ONE statement on its own, first, and let it finish, before cpa-credential.sql
-- (Postgres won't let a new enum value be used in the same transaction that adds it). Safe to run again.
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'cpa';
