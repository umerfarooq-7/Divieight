-- Module 22: the bookkeeping foundation. One double-entry ledger per property LLC. Run once in the Supabase SQL editor,
-- AFTER owner-dashboard.sql, resale-completion.sql (cap_table_history) and heavy-lifting-agent.sql. Safe to re-run.
--
-- What this adds (and what it deliberately does not):
--  * A chart of accounts, versioned. Every property uses the same standard chart. Revising it makes a NEW version; entries
--    already posted keep the accounts (and so the classification) they were posted with. Nothing is ever remapped.
--  * A journal: entries and lines, in integer cents. Debits equal credits for every entry, checked by the database.
--  * Append-only: no UPDATE, DELETE or TRUNCATE on the journal for any role. A correction is a new reversing entry that points
--    back at the one it reverses. (An entry's effective state, "reversed" or not, is read from the journal_entry_state view.)
--  * Accounting periods. A closed period refuses posting, except a flagged adjustment by the Manager with a reason.
--  * Only the functions below can write. Nobody, not even the service role, inserts into the journal directly.
--  * Every posting, reversal and period close is written to the audit log (the Audit Vault) with who, what, when to the
--    millisecond, and where.
--  * It does NOT duplicate owner_capital_accounts, expenses, capital calls or distribution_events: later prompts connect them
--    by posting entries with source 'expense', 'capital_call', 'distribution' and so on.
--  * There is deliberately NO short-term-rental revenue account. Short-term-rental income does not accrue to the LLC (COOA
--    Section 10); the chart only has "Other Income" for incidental LLC income, and the database refuses a rental-revenue account.

-- ---------------------------------------------------------------------------------------------------------
-- 1. The chart of accounts
-- ---------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.coa_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK (version > 0),
  effective_from date NOT NULL DEFAULT current_date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.coa_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES public.coa_versions(id),
  code text NOT NULL CHECK (code ~ '^[0-9]{4}$'),
  name text NOT NULL CHECK (btrim(name) <> ''),
  type text NOT NULL CHECK (type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  -- True for the accounts kept per member (contributions, distributions, the capital account): a line on one names the member.
  is_member_control boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (version_id, code)
);

-- No short-term-rental revenue account, ever (COOA Section 10).
CREATE OR REPLACE FUNCTION public.coa_accounts_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A chart of accounts is never edited. Make a new version instead.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.type = 'income' AND NEW.name ~* '(short[- ]?term|\mstr\M|airbnb|vrbo|nightly|vacation|guest).*(rental|rent|revenue|income)|rental (revenue|income)' AND NEW.name !~* '^other income' THEN
    RAISE EXCEPTION 'The LLC has no short-term-rental revenue account: that income does not accrue to the LLC (COOA Section 10).' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS coa_accounts_guard ON public.coa_accounts;
CREATE TRIGGER coa_accounts_guard BEFORE INSERT OR UPDATE OR DELETE ON public.coa_accounts
  FOR EACH ROW EXECUTE FUNCTION public.coa_accounts_guard();

CREATE OR REPLACE FUNCTION public.coa_versions_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A chart version is never edited or deleted. Make a new version instead.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS coa_versions_guard ON public.coa_versions;
CREATE TRIGGER coa_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.coa_versions
  FOR EACH ROW EXECUTE FUNCTION public.coa_versions_guard();

-- Version 1: the standard chart every property starts with.
DO $$
DECLARE v uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.coa_versions WHERE version = 1) THEN
    INSERT INTO public.coa_versions (version, effective_from, notes) VALUES (1, DATE '2000-01-01', 'Standard chart for every property LLC')
    RETURNING id INTO v;
    INSERT INTO public.coa_accounts (version_id, code, name, type, normal_balance, is_member_control) VALUES
      (v, '1000', 'Cash (LLC operating account)', 'asset', 'debit', false),
      (v, '1100', 'Prepaid and Other Assets', 'asset', 'debit', false),
      (v, '1200', 'Property (acquisition cost)', 'asset', 'debit', false),
      (v, '1210', 'Furnishings and Capital Improvements', 'asset', 'debit', false),
      (v, '1290', 'Accumulated Depreciation', 'asset', 'credit', false),
      (v, '3000', 'Member Capital Contributions', 'equity', 'credit', true),
      (v, '3100', 'Member Distributions', 'equity', 'debit', true),
      (v, '3200', 'Member Capital Account (control)', 'equity', 'credit', true),
      (v, '4000', 'Other Income (incidental LLC income only)', 'income', 'credit', false),
      (v, '6000', 'Property Tax Expense', 'expense', 'debit', false),
      (v, '6100', 'Hazard Insurance Expense', 'expense', 'debit', false),
      (v, '6110', 'Umbrella Insurance Expense', 'expense', 'debit', false),
      (v, '6200', 'HOA Dues Expense', 'expense', 'debit', false),
      (v, '6300', 'Utilities Expense', 'expense', 'debit', false),
      (v, '6400', 'Repairs and Maintenance Expense', 'expense', 'debit', false),
      (v, '6500', 'Property Management Fee Expense', 'expense', 'debit', false),
      (v, '6600', 'Cleaning and Turnover Expense', 'expense', 'debit', false);
  END IF;
END $$;

-- A revision: a new version, copied from the latest, with the changes applied as it is made. The old version, and every
-- entry posted on it, is untouched. _changes: [{"code": "6700", "name": "...", "type": "expense", "normal_balance": "debit",
-- "is_member_control": false}] adds or replaces an account; [{"code": "6600", "active": false}] retires one.
CREATE OR REPLACE FUNCTION public.create_coa_version(_notes text, _effective_from date DEFAULT current_date, _changes jsonb DEFAULT '[]'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  latest public.coa_versions%ROWTYPE;
  nv uuid;
  c jsonb;
  src public.coa_accounts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('create_coa_version'));
  SELECT * INTO latest FROM public.coa_versions ORDER BY version DESC LIMIT 1;
  IF _effective_from < latest.effective_from THEN
    RAISE EXCEPTION 'A new chart version can''t take effect before the one it follows (%).', latest.effective_from USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.coa_versions (version, effective_from, notes) VALUES (latest.version + 1, _effective_from, _notes) RETURNING id INTO nv;
  FOR src IN SELECT * FROM public.coa_accounts WHERE version_id = latest.id ORDER BY code LOOP
    c := (SELECT e FROM jsonb_array_elements(COALESCE(_changes, '[]'::jsonb)) e WHERE e->>'code' = src.code LIMIT 1);
    INSERT INTO public.coa_accounts (version_id, code, name, type, normal_balance, is_member_control, active)
    VALUES (nv, src.code, COALESCE(c->>'name', src.name), COALESCE(c->>'type', src.type), COALESCE(c->>'normal_balance', src.normal_balance),
            COALESCE((c->>'is_member_control')::boolean, src.is_member_control), COALESCE((c->>'active')::boolean, src.active));
  END LOOP;
  FOR c IN SELECT e FROM jsonb_array_elements(COALESCE(_changes, '[]'::jsonb)) e
           WHERE NOT EXISTS (SELECT 1 FROM public.coa_accounts a WHERE a.version_id = nv AND a.code = e->>'code') LOOP
    INSERT INTO public.coa_accounts (version_id, code, name, type, normal_balance, is_member_control, active)
    VALUES (nv, c->>'code', c->>'name', c->>'type', c->>'normal_balance', COALESCE((c->>'is_member_control')::boolean, false), COALESCE((c->>'active')::boolean, true));
  END LOOP;
  RETURN nv;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 2. Periods
-- ---------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.accounting_periods (
  property_id uuid NOT NULL REFERENCES public.properties(id),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by uuid,
  closed_at timestamptz,
  PRIMARY KEY (property_id, year, month),
  CHECK (status = 'open' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL))
);

-- A period closes once and stays closed.
CREATE OR REPLACE FUNCTION public.accounting_periods_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An accounting period is never deleted.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'closed' THEN
    RAISE EXCEPTION 'A closed accounting period stays closed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS accounting_periods_guard ON public.accounting_periods;
CREATE TRIGGER accounting_periods_guard BEFORE UPDATE OR DELETE ON public.accounting_periods
  FOR EACH ROW EXECUTE FUNCTION public.accounting_periods_guard();

-- ---------------------------------------------------------------------------------------------------------
-- 3. The journal (append-only)
-- ---------------------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  entry_date date NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL CHECK (source IN ('plaid', 'manual', 'system', 'capital_call', 'expense', 'distribution', 'resale', 'opening')),
  source_ref text,
  memo text,
  -- 'posted' for every entry as written. Whether one has since been reversed is read from journal_entry_state, because
  -- nothing in the journal is ever updated.
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  reverses_entry_id uuid REFERENCES public.journal_entries(id),
  reversal_reason text,
  created_by uuid,
  coa_version_id uuid NOT NULL REFERENCES public.coa_versions(id),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  is_adjustment boolean NOT NULL DEFAULT false,
  adjustment_reason text,
  CHECK (NOT is_adjustment OR (adjustment_reason IS NOT NULL AND btrim(adjustment_reason) <> '')),
  CHECK (reverses_entry_id IS NULL OR (reversal_reason IS NOT NULL AND btrim(reversal_reason) <> '')),
  CHECK (period = to_char(entry_date, 'YYYY-MM'))
);
CREATE INDEX IF NOT EXISTS journal_entries_property_idx ON public.journal_entries (property_id, entry_date, posted_at);
-- An entry is reversed at most once, and a reversal is not itself reversed (post a new entry instead).
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_reversal ON public.journal_entries (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES public.journal_entries(id),
  account_id uuid NOT NULL REFERENCES public.coa_accounts(id),
  member_id uuid,
  debit_cents bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  -- A line is a debit or a credit, never both and never neither.
  CHECK ((debit_cents > 0) <> (credit_cents > 0))
);
CREATE INDEX IF NOT EXISTS journal_lines_entry_idx ON public.journal_lines (entry_id);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON public.journal_lines (account_id, member_id);

-- Append-only, for every role: no UPDATE, DELETE or TRUNCATE.
CREATE OR REPLACE FUNCTION public.journal_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'The journal is append-only: nothing in it is changed or deleted. Post a reversing entry instead.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS journal_entries_append_only ON public.journal_entries;
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.journal_append_only();
DROP TRIGGER IF EXISTS journal_lines_append_only ON public.journal_lines;
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.journal_append_only();
DROP TRIGGER IF EXISTS journal_entries_no_truncate ON public.journal_entries;
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON public.journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.journal_append_only();
DROP TRIGGER IF EXISTS journal_lines_no_truncate ON public.journal_lines;
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON public.journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION public.journal_append_only();

-- A line's account is on the entry's chart version, and a member account names a member (any other account names none).
CREATE OR REPLACE FUNCTION public.journal_lines_check()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  a public.coa_accounts%ROWTYPE;
  entry_version uuid;
BEGIN
  SELECT * INTO a FROM public.coa_accounts WHERE id = NEW.account_id;
  SELECT coa_version_id INTO entry_version FROM public.journal_entries WHERE id = NEW.entry_id;
  IF a.version_id IS DISTINCT FROM entry_version THEN
    RAISE EXCEPTION 'That account is on a different chart version from the entry.' USING ERRCODE = 'check_violation';
  END IF;
  IF a.is_member_control AND NEW.member_id IS NULL THEN
    RAISE EXCEPTION 'Account % (%) is kept per member: name the member.', a.code, a.name USING ERRCODE = 'check_violation';
  END IF;
  IF NOT a.is_member_control AND NEW.member_id IS NOT NULL THEN
    RAISE EXCEPTION 'Account % (%) isn''t kept per member: leave the member out.', a.code, a.name USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS journal_lines_check ON public.journal_lines;
CREATE TRIGGER journal_lines_check BEFORE INSERT ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.journal_lines_check();

-- Every entry balances: debits equal credits, and there are at least two lines. Checked when the transaction commits, so
-- the lines can go in one at a time but an unbalanced entry can never be committed.
CREATE OR REPLACE FUNCTION public.journal_entry_balanced()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  entry uuid;
  d bigint;
  c bigint;
  n integer;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN entry := (to_jsonb(NEW) ->> 'id')::uuid; ELSE entry := (to_jsonb(NEW) ->> 'entry_id')::uuid; END IF;
  SELECT COALESCE(sum(debit_cents), 0), COALESCE(sum(credit_cents), 0), count(*) INTO d, c, n FROM public.journal_lines WHERE entry_id = entry;
  IF n < 2 THEN
    RAISE EXCEPTION 'An entry needs at least two lines.' USING ERRCODE = 'check_violation';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'The entry is unbalanced: debits % cents, credits % cents.', d, c USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS journal_lines_balanced ON public.journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON public.journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.journal_entry_balanced();
DROP TRIGGER IF EXISTS journal_entries_balanced ON public.journal_entries;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.journal_entry_balanced();

-- Whether an entry has been reversed: derived, never stored.
CREATE OR REPLACE VIEW public.journal_entry_state WITH (security_invoker = true) AS
  SELECT e.id AS entry_id, e.property_id,
         CASE WHEN EXISTS (SELECT 1 FROM public.journal_entries r WHERE r.reverses_entry_id = e.id) THEN 'reversed' ELSE 'posted' END AS effective_status,
         (SELECT r.id FROM public.journal_entries r WHERE r.reverses_entry_id = e.id) AS reversed_by_entry_id
  FROM public.journal_entries e;

-- ---------------------------------------------------------------------------------------------------------
-- 4. Who can write and who can read
-- ---------------------------------------------------------------------------------------------------------

ALTER TABLE public.coa_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coa_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;

-- Nobody writes directly, not even the service role: the SECURITY DEFINER functions below are the only way in.
REVOKE ALL ON public.coa_versions, public.coa_accounts, public.accounting_periods, public.journal_entries, public.journal_lines FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.coa_versions, public.coa_accounts TO authenticated, service_role;
GRANT SELECT ON public.accounting_periods, public.journal_entries, public.journal_lines TO authenticated, service_role;
GRANT SELECT ON public.journal_entry_state TO authenticated, service_role;

DROP POLICY IF EXISTS "signed-in users read the chart versions" ON public.coa_versions;
CREATE POLICY "signed-in users read the chart versions" ON public.coa_versions FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "signed-in users read the chart" ON public.coa_accounts;
CREATE POLICY "signed-in users read the chart" ON public.coa_accounts FOR SELECT TO authenticated USING (true);

-- The Manager (an admin) reads everything; an Account Member reads their property's ledger, read-only. (A Heavy Lifting Agent
-- and the CPA read through the server functions, which leave member detail out; they have no direct access to the tables.)
DROP POLICY IF EXISTS "manager and members read the periods" ON public.accounting_periods;
CREATE POLICY "manager and members read the periods" ON public.accounting_periods FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.is_property_owner(auth.uid(), property_id));
DROP POLICY IF EXISTS "manager and members read the journal" ON public.journal_entries;
CREATE POLICY "manager and members read the journal" ON public.journal_entries FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.is_property_owner(auth.uid(), property_id));
DROP POLICY IF EXISTS "manager and members read the lines" ON public.journal_lines;
CREATE POLICY "manager and members read the lines" ON public.journal_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.journal_entries e WHERE e.id = entry_id AND (public.has_role(auth.uid(), 'admin') OR public.is_property_owner(auth.uid(), e.property_id))));

-- ---------------------------------------------------------------------------------------------------------
-- 5. Functions
-- ---------------------------------------------------------------------------------------------------------

-- The Audit Vault entry for a ledger action. When is to the millisecond.
CREATE OR REPLACE FUNCTION public.ledger_audit(_actor uuid, _action text, _entity uuid, _meta jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, CASE WHEN _actor IS NULL THEN 'system' ELSE 'admin' END, _action, 'journal_entry', _entity::text,
          _meta || jsonb_build_object('at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
END;
$$;

-- Was this person ever a member (holder) of this property? A member account line has to name one.
CREATE OR REPLACE FUNCTION public.is_ledger_member(_property uuid, _member uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.cap_table_entries c WHERE c.property_id = _property AND (c.buyer_account_id = _member OR c.seller_id = _member))
      OR EXISTS (SELECT 1 FROM public.cap_table_history h WHERE h.property_id = _property
                 AND (h.from_buyer_account_id = _member OR h.from_seller_id = _member OR h.to_buyer_account_id = _member OR h.to_seller_id = _member));
$$;

CREATE OR REPLACE FUNCTION public.post_entry(_property uuid, _lines jsonb, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  entry_date date := COALESCE((_meta->>'entry_date')::date, current_date);
  src text := _meta->>'source';
  actor uuid := NULLIF(_meta->>'created_by', '')::uuid;
  adjustment boolean := COALESCE((_meta->>'is_adjustment')::boolean, false);
  reason text := NULLIF(btrim(COALESCE(_meta->>'adjustment_reason', '')), '');
  ver public.coa_versions%ROWTYPE;
  period_row public.accounting_periods%ROWTYPE;
  l jsonb;
  acct public.coa_accounts%ROWTYPE;
  dr bigint;
  cr bigint;
  total_d bigint := 0;
  total_c bigint := 0;
  n integer := 0;
  new_id uuid;
  line_ids uuid[] := '{}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = _property) THEN
    RAISE EXCEPTION 'Property not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF src IS NULL OR src NOT IN ('plaid', 'manual', 'system', 'capital_call', 'expense', 'distribution', 'resale', 'opening') THEN
    RAISE EXCEPTION 'Say where this entry comes from (plaid, manual, system, capital_call, expense, distribution, resale or opening).' USING ERRCODE = 'check_violation';
  END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) < 2 THEN
    RAISE EXCEPTION 'An entry needs at least two lines.' USING ERRCODE = 'check_violation';
  END IF;

  -- The chart in force on the entry's date.
  SELECT * INTO ver FROM public.coa_versions WHERE effective_from <= entry_date ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No chart of accounts is in force on %.', entry_date USING ERRCODE = 'no_data_found';
  END IF;

  -- The period.
  SELECT * INTO period_row FROM public.accounting_periods WHERE property_id = _property AND year = extract(year FROM entry_date)::int AND month = extract(month FROM entry_date)::int;
  IF FOUND AND period_row.status = 'closed' THEN
    IF NOT adjustment THEN
      RAISE EXCEPTION 'The period % is closed. Only a flagged adjustment by the Manager, with a reason, can post to it.', to_char(entry_date, 'YYYY-MM') USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF adjustment THEN
    IF reason IS NULL THEN
      RAISE EXCEPTION 'An adjustment needs a reason.' USING ERRCODE = 'check_violation';
    END IF;
    IF actor IS NULL OR NOT public.has_role(actor, 'admin') THEN
      RAISE EXCEPTION 'Only the Manager can post an adjustment.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Validate every line before anything is written.
  FOR l IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    n := n + 1;
    IF COALESCE((l->>'debit_cents')::numeric, 0) <> floor(COALESCE((l->>'debit_cents')::numeric, 0)) OR COALESCE((l->>'credit_cents')::numeric, 0) <> floor(COALESCE((l->>'credit_cents')::numeric, 0)) THEN
      RAISE EXCEPTION 'Line %: amounts are whole numbers of cents.', n USING ERRCODE = 'check_violation';
    END IF;
    dr := COALESCE((l->>'debit_cents')::bigint, 0);
    cr := COALESCE((l->>'credit_cents')::bigint, 0);
    IF dr < 0 OR cr < 0 OR (dr > 0) = (cr > 0) THEN
      RAISE EXCEPTION 'Line %: each line is a debit or a credit, above zero, not both.', n USING ERRCODE = 'check_violation';
    END IF;
    IF l->>'account_id' IS NOT NULL THEN
      SELECT * INTO acct FROM public.coa_accounts WHERE id = (l->>'account_id')::uuid;
    ELSE
      SELECT * INTO acct FROM public.coa_accounts WHERE version_id = ver.id AND code = l->>'code';
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Line %: that account doesn''t exist.', n USING ERRCODE = 'no_data_found';
    END IF;
    IF acct.version_id <> ver.id THEN
      RAISE EXCEPTION 'Line %: account % is on chart version %, but chart version % is in force on %.', n, acct.code, (SELECT version FROM public.coa_versions WHERE id = acct.version_id), ver.version, entry_date USING ERRCODE = 'check_violation';
    END IF;
    IF NOT acct.active THEN
      RAISE EXCEPTION 'Line %: account % (%) is retired.', n, acct.code, acct.name USING ERRCODE = 'check_violation';
    END IF;
    IF acct.is_member_control THEN
      IF NULLIF(l->>'member_id', '') IS NULL THEN
        RAISE EXCEPTION 'Line %: account % (%) is kept per member: name the member.', n, acct.code, acct.name USING ERRCODE = 'check_violation';
      END IF;
      IF NOT public.is_ledger_member(_property, (l->>'member_id')::uuid) THEN
        RAISE EXCEPTION 'Line %: that person isn''t a member of this property.', n USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NULLIF(l->>'member_id', '') IS NOT NULL THEN
      RAISE EXCEPTION 'Line %: account % (%) isn''t kept per member: leave the member out.', n, acct.code, acct.name USING ERRCODE = 'check_violation';
    END IF;
    total_d := total_d + dr;
    total_c := total_c + cr;
  END LOOP;
  IF total_d <> total_c THEN
    RAISE EXCEPTION 'The entry is unbalanced: debits % cents, credits % cents.', total_d, total_c USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.journal_entries (property_id, entry_date, source, source_ref, memo, created_by, coa_version_id, period, is_adjustment, adjustment_reason)
  VALUES (_property, entry_date, src, _meta->>'source_ref', _meta->>'memo', actor, ver.id, to_char(entry_date, 'YYYY-MM'), adjustment, reason)
  RETURNING id INTO new_id;
  FOR l IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    IF l->>'account_id' IS NOT NULL THEN
      SELECT * INTO acct FROM public.coa_accounts WHERE id = (l->>'account_id')::uuid;
    ELSE
      SELECT * INTO acct FROM public.coa_accounts WHERE version_id = ver.id AND code = l->>'code';
    END IF;
    INSERT INTO public.journal_lines (entry_id, account_id, member_id, debit_cents, credit_cents)
    VALUES (new_id, acct.id, NULLIF(l->>'member_id', '')::uuid, COALESCE((l->>'debit_cents')::bigint, 0), COALESCE((l->>'credit_cents')::bigint, 0));
  END LOOP;

  PERFORM public.ledger_audit(actor, 'ledger.entry_posted', new_id, jsonb_build_object(
    'property_id', _property, 'source', src, 'source_ref', _meta->>'source_ref', 'entry_date', entry_date, 'period', to_char(entry_date, 'YYYY-MM'),
    'lines', jsonb_array_length(_lines), 'total_cents', total_d, 'coa_version', ver.version,
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  IF adjustment THEN
    PERFORM public.ledger_audit(actor, 'ledger.adjustment_posted', new_id, jsonb_build_object('property_id', _property, 'period', to_char(entry_date, 'YYYY-MM'), 'reason', reason, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  END IF;
  RETURN new_id;
END;
$$;

-- A correction: a new entry with every line flipped, pointing back at the one it reverses, on the same chart version.
CREATE OR REPLACE FUNCTION public.reverse_entry(_entry uuid, _reason text, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  orig public.journal_entries%ROWTYPE;
  actor uuid := NULLIF(_meta->>'created_by', '')::uuid;
  entry_date date := COALESCE((_meta->>'entry_date')::date, current_date);
  adjustment boolean := COALESCE((_meta->>'is_adjustment')::boolean, false);
  adj_reason text := NULLIF(btrim(COALESCE(_meta->>'adjustment_reason', '')), '');
  period_row public.accounting_periods%ROWTYPE;
  why text := NULLIF(btrim(COALESCE(_reason, '')), '');
  new_id uuid;
  total bigint;
BEGIN
  IF why IS NULL THEN
    RAISE EXCEPTION 'Say why this entry is being reversed.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO orig FROM public.journal_entries WHERE id = _entry;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF orig.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'A reversal can''t itself be reversed. Post a new entry instead.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE reverses_entry_id = _entry) THEN
    RAISE EXCEPTION 'This entry was already reversed.' USING ERRCODE = 'unique_violation';
  END IF;
  SELECT * INTO period_row FROM public.accounting_periods WHERE property_id = orig.property_id AND year = extract(year FROM entry_date)::int AND month = extract(month FROM entry_date)::int;
  IF FOUND AND period_row.status = 'closed' AND NOT adjustment THEN
    RAISE EXCEPTION 'The period % is closed. Only a flagged adjustment by the Manager, with a reason, can post to it.', to_char(entry_date, 'YYYY-MM') USING ERRCODE = 'check_violation';
  END IF;
  IF adjustment THEN
    IF adj_reason IS NULL THEN
      RAISE EXCEPTION 'An adjustment needs a reason.' USING ERRCODE = 'check_violation';
    END IF;
    IF actor IS NULL OR NOT public.has_role(actor, 'admin') THEN
      RAISE EXCEPTION 'Only the Manager can post an adjustment.' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  INSERT INTO public.journal_entries (property_id, entry_date, source, source_ref, memo, reverses_entry_id, reversal_reason, created_by, coa_version_id, period, is_adjustment, adjustment_reason)
  VALUES (orig.property_id, entry_date, orig.source, orig.source_ref, 'Reversal of ' || orig.id::text || ': ' || why, orig.id, why, actor, orig.coa_version_id, to_char(entry_date, 'YYYY-MM'), adjustment, adj_reason)
  RETURNING id INTO new_id;
  INSERT INTO public.journal_lines (entry_id, account_id, member_id, debit_cents, credit_cents)
  SELECT new_id, account_id, member_id, credit_cents, debit_cents FROM public.journal_lines WHERE entry_id = orig.id;
  SELECT sum(debit_cents) INTO total FROM public.journal_lines WHERE entry_id = new_id;

  PERFORM public.ledger_audit(actor, 'ledger.entry_reversed', new_id, jsonb_build_object(
    'property_id', orig.property_id, 'reverses_entry_id', orig.id, 'reason', why, 'total_cents', total, 'period', to_char(entry_date, 'YYYY-MM'),
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  IF adjustment THEN
    PERFORM public.ledger_audit(actor, 'ledger.adjustment_posted', new_id, jsonb_build_object('property_id', orig.property_id, 'period', to_char(entry_date, 'YYYY-MM'), 'reason', adj_reason, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  END IF;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_period(_property uuid, _year integer, _month integer, _by uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _by IS NULL OR NOT public.has_role(_by, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can close a period.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = _property) THEN
    RAISE EXCEPTION 'Property not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_periods WHERE property_id = _property AND year = _year AND month = _month AND status = 'closed') THEN
    RAISE EXCEPTION 'That period is already closed.' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO public.accounting_periods (property_id, year, month, status, closed_by, closed_at)
  VALUES (_property, _year, _month, 'closed', _by, clock_timestamp())
  ON CONFLICT (property_id, year, month) DO UPDATE SET status = 'closed', closed_by = EXCLUDED.closed_by, closed_at = EXCLUDED.closed_at;
  PERFORM public.ledger_audit(_by, 'ledger.period_closed', _property, jsonb_build_object('property_id', _property, 'period', format('%s-%s', _year, lpad(_month::text, 2, '0')), 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- The trial balance as of a date: every account (and, for member accounts, every member) with its debits, credits and balance.
-- Reversals are entries like any other, so a reversed entry nets to nothing without being removed.
CREATE OR REPLACE FUNCTION public.trial_balance(_property uuid, _as_of date DEFAULT current_date)
RETURNS TABLE (account_id uuid, coa_version integer, code text, name text, type text, normal_balance text, member_id uuid, debit_cents bigint, credit_cents bigint, balance_cents bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT a.id, v.version, a.code, a.name, a.type, a.normal_balance, l.member_id,
         COALESCE(sum(l.debit_cents), 0)::bigint, COALESCE(sum(l.credit_cents), 0)::bigint,
         (CASE WHEN a.normal_balance = 'debit' THEN COALESCE(sum(l.debit_cents), 0) - COALESCE(sum(l.credit_cents), 0)
               ELSE COALESCE(sum(l.credit_cents), 0) - COALESCE(sum(l.debit_cents), 0) END)::bigint
  FROM public.journal_entries e
  JOIN public.journal_lines l ON l.entry_id = e.id
  JOIN public.coa_accounts a ON a.id = l.account_id
  JOIN public.coa_versions v ON v.id = a.version_id
  WHERE e.property_id = _property AND e.entry_date <= _as_of
  GROUP BY a.id, v.version, a.code, a.name, a.type, a.normal_balance, l.member_id
  ORDER BY a.code, v.version, l.member_id;
$$;

-- One account's activity in a date range, with the running balance (which includes everything before the range).
CREATE OR REPLACE FUNCTION public.account_ledger(_property uuid, _account uuid, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE (entry_id uuid, entry_date date, posted_at timestamptz, source text, source_ref text, memo text, reverses_entry_id uuid, member_id uuid, debit_cents bigint, credit_cents bigint, running_balance_cents bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH sign AS (SELECT CASE WHEN normal_balance = 'debit' THEN 1 ELSE -1 END AS s FROM public.coa_accounts WHERE id = _account),
  rows AS (
    SELECT e.id AS entry_id, e.entry_date, e.posted_at, e.source, e.source_ref, e.memo, e.reverses_entry_id, l.member_id, l.debit_cents, l.credit_cents, l.id AS line_id,
           sum((l.debit_cents - l.credit_cents) * (SELECT s FROM sign)) OVER (ORDER BY e.entry_date, e.posted_at, l.id) AS running
    FROM public.journal_entries e JOIN public.journal_lines l ON l.entry_id = e.id
    WHERE e.property_id = _property AND l.account_id = _account
  )
  SELECT entry_id, entry_date, posted_at, source, source_ref, memo, reverses_entry_id, member_id, debit_cents, credit_cents, running::bigint
  FROM rows WHERE (_from IS NULL OR entry_date >= _from) AND (_to IS NULL OR entry_date <= _to)
  ORDER BY entry_date, posted_at, line_id;
$$;

-- Only the server (service role) calls these; who may ask is decided there (Manager, member, Heavy Lifting Agent, CPA).
REVOKE ALL ON FUNCTION public.post_entry(uuid, jsonb, jsonb), public.reverse_entry(uuid, text, jsonb), public.close_period(uuid, integer, integer, uuid, jsonb),
  public.create_coa_version(text, date, jsonb), public.trial_balance(uuid, date), public.account_ledger(uuid, uuid, date, date),
  public.ledger_audit(uuid, text, uuid, jsonb), public.is_ledger_member(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_entry(uuid, jsonb, jsonb), public.reverse_entry(uuid, text, jsonb), public.close_period(uuid, integer, integer, uuid, jsonb),
  public.create_coa_version(text, date, jsonb), public.trial_balance(uuid, date), public.account_ledger(uuid, uuid, date, date) TO service_role;
