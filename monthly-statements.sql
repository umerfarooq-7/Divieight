-- Month 6, Prompt 10: Monthly Co-owner Statements.
-- Run in the Supabase SQL editor AFTER bookkeeping.sql, capital-accounts.sql, bank-feed.sql, books.sql, capital-events.sql and
-- owner-notifications.sql. Safe to run again.
--
--   * One statement per capital account (member_key) per property per month. A two-member Buyer Account is ONE capital account,
--     so it gets ONE statement, which both members see (they share the account).
--   * Every number comes from the ledger: the member's capital_account_ledger lines, and the LLC's income and expense accounts in the
--     journal. The expense and income ALLOCATION entries (which pass the cost on to the members) are left out of the LLC's own
--     activity, so the LLC's expense shows what it spent, not the net zero the allocation leaves.
--   * A statement is an immutable snapshot. Versions: draft -> issued -> superseded. If a correction changes a past month a NEW
--     version is made and, when the Manager issues it, the old one is marked superseded. Both stay viewable.
--   * Statements are never withheld from an owner for any status reason (Rev 48 floor): there is no gate on an owner's standing.

-- ---------------------------------------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.monthly_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  -- The capital account: a Buyer Account id, or a seller id for a Hybrid Exit seller's retained shares.
  member_key uuid NOT NULL,
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'superseded')),
  pdf_url text,
  data_snapshot jsonb NOT NULL,
  -- A hash of the numbers as built (not the time it was built, not the Manager's notes): the same ledger always gives the same hash.
  snapshot_hash text NOT NULL,
  manager_notes text,
  issued_at timestamptz,
  issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, member_key, period, version),
  CHECK ((status = 'draft') = (issued_at IS NULL))
);
-- At most one draft and one issued statement per member per month (a correction's draft waits beside the issued version it will replace).
CREATE UNIQUE INDEX IF NOT EXISTS monthly_statements_one_draft ON public.monthly_statements (property_id, member_key, period) WHERE status = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS monthly_statements_one_issued ON public.monthly_statements (property_id, member_key, period) WHERE status = 'issued';
CREATE INDEX IF NOT EXISTS monthly_statements_member_idx ON public.monthly_statements (property_id, member_key, period DESC, version DESC);

CREATE OR REPLACE FUNCTION public.monthly_statements_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A statement is never deleted.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.property_id <> OLD.property_id OR NEW.member_key <> OLD.member_key OR NEW.period <> OLD.period OR NEW.version <> OLD.version OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A statement''s property, member, month and version never change.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'superseded' THEN
      RAISE EXCEPTION 'A draft is issued before it can be superseded.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW; -- a draft's numbers and notes can be refreshed until it is issued
  END IF;
  -- Issued and superseded statements are snapshots: the numbers, the notes and the issue are fixed.
  IF NEW.data_snapshot IS DISTINCT FROM OLD.data_snapshot OR NEW.snapshot_hash <> OLD.snapshot_hash OR NEW.manager_notes IS DISTINCT FROM OLD.manager_notes
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.issued_by IS DISTINCT FROM OLD.issued_by THEN
    RAISE EXCEPTION 'An issued statement is a snapshot and can''t be edited. A correction is a new version.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.pdf_url IS NOT NULL AND NEW.pdf_url IS DISTINCT FROM OLD.pdf_url THEN
    RAISE EXCEPTION 'An issued statement''s PDF is fixed.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'issued' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'A statement can''t go from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS monthly_statements_history ON public.monthly_statements;
CREATE TRIGGER monthly_statements_history BEFORE UPDATE OR DELETE ON public.monthly_statements FOR EACH ROW EXECUTE FUNCTION public.monthly_statements_guard();

-- ---------------------------------------------------------------------------------------------------------
-- 2. Helpers and the snapshot
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.statement_audit(_actor uuid, _action text, _id uuid, _meta jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, CASE WHEN _actor IS NULL THEN 'system' ELSE 'admin' END, _action, 'monthly_statement', _id::text,
          _meta || jsonb_build_object('at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
END;
$$;

CREATE OR REPLACE FUNCTION public.statement_require_manager(_actor uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can do that.' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- The LLC's own income and expense in a date range, from the journal, by account. Allocation entries (and their reversals) are left out: they
-- only pass what the LLC earned or spent on to the members' capital accounts.
CREATE OR REPLACE FUNCTION public.statement_llc_activity(_property uuid, _from date, _to date, _items boolean)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  WITH pl AS (
    SELECT e.id AS entry_id, e.entry_date, e.memo, a.code, a.name, a.type,
           CASE WHEN a.type = 'income' THEN l.credit_cents - l.debit_cents ELSE l.debit_cents - l.credit_cents END AS cents
    FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
    WHERE e.property_id = _property AND e.entry_date BETWEEN _from AND _to AND a.type IN ('income', 'expense')
      AND COALESCE(e.source_ref, '') NOT LIKE 'allocation-%'
      AND NOT EXISTS (SELECT 1 FROM public.journal_entries o WHERE o.id = e.reverses_entry_id AND COALESCE(o.source_ref, '') LIKE 'allocation-%')
  ), by_acct AS (
    SELECT type, code, name, sum(cents)::bigint AS total,
           CASE WHEN _items THEN jsonb_agg(jsonb_build_object('date', entry_date, 'memo', COALESCE(memo, ''), 'amount_cents', cents) ORDER BY entry_date, entry_id) ELSE NULL END AS items
    FROM pl GROUP BY type, code, name
  )
  SELECT jsonb_build_object(
    'income_cents', COALESCE((SELECT sum(total) FROM by_acct WHERE type = 'income'), 0)::bigint,
    'expense_cents', COALESCE((SELECT sum(total) FROM by_acct WHERE type = 'expense'), 0)::bigint,
    'net_cents', (COALESCE((SELECT sum(total) FROM by_acct WHERE type = 'income'), 0) - COALESCE((SELECT sum(total) FROM by_acct WHERE type = 'expense'), 0))::bigint,
    'income', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', code, 'name', name, 'total_cents', total, 'items', COALESCE(items, '[]'::jsonb)) ORDER BY code) FROM by_acct WHERE type = 'income'), '[]'::jsonb),
    'expense', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', code, 'name', name, 'total_cents', total, 'items', COALESCE(items, '[]'::jsonb)) ORDER BY code) FROM by_acct WHERE type = 'expense'), '[]'::jsonb));
$$;

-- A member's capital account over a range, signed as it affects capital: what moved it, and where it began and ended.
CREATE OR REPLACE FUNCTION public.statement_capital(_property uuid, _member uuid, _from date, _to date)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'opening_cents', COALESCE(sum(amount_cents) FILTER (WHERE effective_date < _from), 0)::bigint,
    'contributions_cents', COALESCE(sum(amount_cents) FILTER (WHERE effective_date BETWEEN _from AND _to AND line_type IN ('opening', 'contribution')), 0)::bigint,
    'distributions_cents', COALESCE(sum(amount_cents) FILTER (WHERE effective_date BETWEEN _from AND _to AND line_type = 'distribution'), 0)::bigint,
    'income_cents', COALESCE(sum(amount_cents) FILTER (WHERE effective_date BETWEEN _from AND _to AND line_type = 'income'), 0)::bigint,
    'expense_cents', COALESCE(sum(amount_cents) FILTER (WHERE effective_date BETWEEN _from AND _to AND line_type = 'expense'), 0)::bigint,
    'depreciation_cents', COALESCE(sum(amount_cents) FILTER (WHERE effective_date BETWEEN _from AND _to AND line_type = 'depreciation'), 0)::bigint,
    'transfers_cents', COALESCE(sum(amount_cents) FILTER (WHERE effective_date BETWEEN _from AND _to AND line_type IN ('transfer_in', 'transfer_out')), 0)::bigint,
    'closing_cents', COALESCE(sum(amount_cents) FILTER (WHERE effective_date <= _to), 0)::bigint)
  FROM public.capital_account_ledger WHERE property_id = _property AND member_key = _member;
$$;

-- Everything on one member's statement for a month. Built only from the ledger.
CREATE OR REPLACE FUNCTION public.build_statement_snapshot(_property uuid, _member uuid, _period text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  d0 date := (_period || '-01')::date;
  d1 date := ((_period || '-01')::date + interval '1 month' - interval '1 day')::date;
  y0 date := make_date(extract(year FROM (_period || '-01')::date)::int, 1, 1);
  prop record;
  llc text;
  my_shares integer;
  all_shares integer;
  lines jsonb;
BEGIN
  SELECT p.address, p.city, p.state, p.zip INTO prop FROM public.properties p WHERE p.id = _property;
  IF to_regclass('public.entity_genesis') IS NOT NULL THEN
    EXECUTE 'SELECT llc_name FROM public.entity_genesis WHERE property_id = $1' INTO llc USING _property;
  END IF;
  SELECT COALESCE(sum(shares) FILTER (WHERE member_id = _member), 0), COALESCE(sum(shares), 0) INTO my_shares, all_shares FROM public.holder_shares_as_of(_property, d1);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('date', c.effective_date, 'type', c.line_type, 'amount_cents', c.amount_cents, 'memo', COALESCE(e.memo, '')) ORDER BY c.effective_date, c.seq), '[]'::jsonb) INTO lines
  FROM public.capital_account_ledger c JOIN public.journal_entries e ON e.id = c.entry_id
  WHERE c.property_id = _property AND c.member_key = _member AND c.effective_date BETWEEN d0 AND d1;
  RETURN jsonb_build_object(
    'schema', 'monthly-statement.v1',
    'period', _period,
    'period_start', d0,
    'period_end', d1,
    'property', jsonb_build_object('property_id', _property, 'address', prop.address, 'city', prop.city, 'state', prop.state, 'zip', prop.zip, 'llc_name', llc,
      'shares', my_shares, 'total_shares', all_shares,
      'interest_percent', CASE WHEN all_shares > 0 THEN to_char(round(my_shares * 10000.0 / all_shares) / 100, 'FM990.00') ELSE '0.00' END),
    'member_key', _member,
    'capital', public.statement_capital(_property, _member, d0, d1) || jsonb_build_object('lines', lines),
    'llc_month', public.statement_llc_activity(_property, d0, d1, true),
    'ytd', jsonb_build_object(
      'year', extract(year FROM d0)::int,
      'capital', (public.statement_capital(_property, _member, y0, d1) - 'opening_cents') || jsonb_build_object('beginning_cents', (public.statement_capital(_property, _member, y0, d1)->>'opening_cents')::bigint),
      'llc', public.statement_llc_activity(_property, y0, d1, false)),
    'generated_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
END;
$$;

CREATE OR REPLACE FUNCTION public.statement_hash(_snapshot jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT encode(sha256(convert_to((_snapshot - 'generated_at')::text, 'UTF8')), 'hex');
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Generate: drafts for every member of a month, and a new version when a correction changed an issued month
-- ---------------------------------------------------------------------------------------------------------
-- Safe to run again and again: a month that hasn't changed adds nothing. A draft is refreshed in place; an issued statement whose
-- numbers no longer match the ledger gets a NEW draft version (the issued one is untouched until the Manager issues the new one).
CREATE OR REPLACE FUNCTION public.generate_monthly_statements(_property uuid, _period text, _actor uuid DEFAULT NULL, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d0 date;
  d1 date;
  m record;
  snap jsonb;
  h text;
  cur public.monthly_statements%ROWTYPE;
  created integer := 0;
  refreshed integer := 0;
  corrections integer := 0;
  unchanged integer := 0;
  new_id uuid;
BEGIN
  IF _actor IS NOT NULL THEN
    PERFORM public.statement_require_manager(_actor);
  END IF;
  IF _period IS NULL OR _period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'The month is YYYY-MM.' USING ERRCODE = 'check_violation';
  END IF;
  d0 := (_period || '-01')::date;
  d1 := (d0 + interval '1 month' - interval '1 day')::date;
  IF d1 >= current_date THEN
    RAISE EXCEPTION 'A statement is made after its month has ended.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.ledger_is_open(_property) THEN
    RETURN jsonb_build_object('status', 'not_open');
  END IF;
  -- Every capital account that has a balance, activity in the month, or shares at the end of it.
  FOR m IN
    SELECT k.member_key FROM (
      SELECT DISTINCT member_key FROM public.capital_account_ledger WHERE property_id = _property AND effective_date <= d1
      UNION SELECT member_id FROM public.holder_shares_as_of(_property, d1)) k
    WHERE EXISTS (SELECT 1 FROM public.holder_shares_as_of(_property, d1) h WHERE h.member_id = k.member_key)
       OR EXISTS (SELECT 1 FROM public.capital_account_ledger c WHERE c.property_id = _property AND c.member_key = k.member_key AND c.effective_date BETWEEN d0 AND d1)
       OR (SELECT COALESCE(sum(amount_cents), 0) FROM public.capital_account_ledger c WHERE c.property_id = _property AND c.member_key = k.member_key AND c.effective_date <= d1) <> 0
    ORDER BY k.member_key
  LOOP
    snap := public.build_statement_snapshot(_property, m.member_key, _period);
    h := public.statement_hash(snap);
    SELECT * INTO cur FROM public.monthly_statements WHERE property_id = _property AND member_key = m.member_key AND period = _period ORDER BY version DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.monthly_statements (property_id, member_key, period, version, status, data_snapshot, snapshot_hash)
      VALUES (_property, m.member_key, _period, 1, 'draft', snap, h) RETURNING id INTO new_id;
      created := created + 1;
      PERFORM public.statement_audit(_actor, 'statement.drafted', new_id, jsonb_build_object('property_id', _property, 'member_key', m.member_key, 'period', _period, 'version', 1, 'hash', h));
    ELSIF cur.status = 'draft' THEN
      IF cur.snapshot_hash <> h THEN
        UPDATE public.monthly_statements SET data_snapshot = snap, snapshot_hash = h WHERE id = cur.id;
        refreshed := refreshed + 1;
      ELSE
        unchanged := unchanged + 1;
      END IF;
    ELSIF cur.status = 'issued' AND cur.snapshot_hash <> h THEN
      INSERT INTO public.monthly_statements (property_id, member_key, period, version, status, data_snapshot, snapshot_hash, manager_notes)
      SELECT _property, m.member_key, _period, cur.version + 1, 'draft', snap, h, cur.manager_notes
      WHERE NOT EXISTS (SELECT 1 FROM public.monthly_statements x WHERE x.property_id = _property AND x.member_key = m.member_key AND x.period = _period AND x.status = 'draft')
      RETURNING id INTO new_id;
      IF new_id IS NOT NULL THEN
        corrections := corrections + 1;
        PERFORM public.statement_audit(_actor, 'statement.correction_drafted', new_id, jsonb_build_object('property_id', _property, 'member_key', m.member_key, 'period', _period,
          'version', cur.version + 1, 'replaces_statement_id', cur.id, 'old_hash', cur.snapshot_hash, 'new_hash', h));
      END IF;
    ELSE
      unchanged := unchanged + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('status', 'ok', 'created', created, 'refreshed', refreshed, 'corrections', corrections, 'unchanged', unchanged);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. The Manager's notes, and issuing
-- ---------------------------------------------------------------------------------------------------------
-- Free text before issuing (an upcoming capital call, an unusual expense, items for the CPA). For every draft of the month, or one member's.
CREATE OR REPLACE FUNCTION public.set_statement_notes(_property uuid, _period text, _member uuid, _notes text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  PERFORM public.statement_require_manager(_actor);
  UPDATE public.monthly_statements SET manager_notes = NULLIF(btrim(left(_notes, 4000)), '')
  WHERE property_id = _property AND period = _period AND status = 'draft' AND (_member IS NULL OR member_key = _member);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.statement_audit(_actor, 'statement.notes_set', _property, jsonb_build_object('property_id', _property, 'period', _period, 'member_key', _member, 'drafts', n,
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN n;
END;
$$;

-- Bulk issue a month's drafts. They stay drafts until the Manager has been through the needs-review queue; if some transactions are still
-- in it the Manager can go ahead anyway, but has to say why. (A month is never held back from the owners for any other reason.)
CREATE OR REPLACE FUNCTION public.issue_monthly_statements(_property uuid, _period text, _actor uuid, _force_reason text DEFAULT NULL, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d1 date;
  pending integer := 0;
  s record;
  old_id uuid;
  out jsonb := '[]'::jsonb;
  n integer := 0;
BEGIN
  PERFORM public.statement_require_manager(_actor);
  IF _period IS NULL OR _period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'The month is YYYY-MM.' USING ERRCODE = 'check_violation';
  END IF;
  d1 := ((_period || '-01')::date + interval '1 month' - interval '1 day')::date;
  IF to_regclass('public.bank_transactions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.bank_transactions WHERE property_id = $1 AND status = ''needs_review'' AND posted_date <= $2' INTO pending USING _property, d1;
  END IF;
  IF pending > 0 AND COALESCE(btrim(_force_reason), '') = '' THEN
    RAISE EXCEPTION '% bank transaction(s) are still in the needs-review queue. Review them first, or issue anyway and say why.', pending USING ERRCODE = 'check_violation';
  END IF;
  -- The numbers are brought up to the ledger as it stands now, then issued.
  PERFORM public.generate_monthly_statements(_property, _period, _actor, _meta);
  FOR s IN SELECT * FROM public.monthly_statements WHERE property_id = _property AND period = _period AND status = 'draft' ORDER BY member_key FOR UPDATE LOOP
    old_id := NULL;
    UPDATE public.monthly_statements SET status = 'superseded' WHERE property_id = _property AND member_key = s.member_key AND period = _period AND status = 'issued' RETURNING id INTO old_id;
    UPDATE public.monthly_statements SET status = 'issued', issued_at = now(), issued_by = _actor,
      data_snapshot = s.data_snapshot || jsonb_build_object('version', s.version, 'manager_notes', s.manager_notes, 'issued_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    WHERE id = s.id;
    n := n + 1;
    out := out || jsonb_build_array(jsonb_build_object('id', s.id, 'member_key', s.member_key, 'version', s.version, 'superseded_id', old_id));
    PERFORM public.statement_audit(_actor, 'statement.issued', s.id, jsonb_build_object('property_id', _property, 'member_key', s.member_key, 'period', _period, 'version', s.version,
      'hash', s.snapshot_hash, 'supersedes', old_id, 'review_queue_pending', pending, 'forced_reason', NULLIF(btrim(_force_reason), ''),
      'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  END LOOP;
  RETURN jsonb_build_object('issued', n, 'statements', out, 'review_queue_pending', pending);
END;
$$;

-- The PDF's place in storage, set once at issue.
CREATE OR REPLACE FUNCTION public.set_statement_pdf(_id uuid, _path text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.monthly_statements SET pdf_url = _path WHERE id = _id AND status IN ('issued', 'superseded') AND pdf_url IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. Reconciliation: every live statement against the journal, recomputed from the raw journal lines
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.statement_reconciliation(_property uuid, _period text)
RETURNS TABLE (statement_id uuid, member_key uuid, version integer, status text,
               snapshot_closing_cents bigint, journal_closing_cents bigint, snapshot_income_cents bigint, journal_income_cents bigint,
               snapshot_expense_cents bigint, journal_expense_cents bigint, snapshot_ytd_net_cents bigint, journal_ytd_net_cents bigint, reconciles boolean)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH w AS (SELECT (_period || '-01')::date AS d0, ((_period || '-01')::date + interval '1 month' - interval '1 day')::date AS d1, make_date(substr(_period, 1, 4)::int, 1, 1) AS y0),
  j AS (
    SELECT s.id,
      (SELECT COALESCE(sum(l.credit_cents - l.debit_cents), 0) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
        WHERE e.property_id = s.property_id AND l.member_id = s.member_key AND a.is_member_control AND e.entry_date <= w.d1)::bigint AS closing,
      (SELECT COALESCE(sum(l.credit_cents - l.debit_cents), 0) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
        WHERE e.property_id = s.property_id AND a.type = 'income' AND e.entry_date BETWEEN w.d0 AND w.d1 AND COALESCE(e.source_ref, '') NOT LIKE 'allocation-%'
          AND NOT EXISTS (SELECT 1 FROM public.journal_entries o WHERE o.id = e.reverses_entry_id AND COALESCE(o.source_ref, '') LIKE 'allocation-%'))::bigint AS income,
      (SELECT COALESCE(sum(l.debit_cents - l.credit_cents), 0) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
        WHERE e.property_id = s.property_id AND a.type = 'expense' AND e.entry_date BETWEEN w.d0 AND w.d1 AND COALESCE(e.source_ref, '') NOT LIKE 'allocation-%'
          AND NOT EXISTS (SELECT 1 FROM public.journal_entries o WHERE o.id = e.reverses_entry_id AND COALESCE(o.source_ref, '') LIKE 'allocation-%'))::bigint AS expense,
      (SELECT COALESCE(sum(l.credit_cents - l.debit_cents), 0)
         FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
        WHERE e.property_id = s.property_id AND a.type IN ('income', 'expense') AND e.entry_date BETWEEN w.y0 AND w.d1 AND COALESCE(e.source_ref, '') NOT LIKE 'allocation-%'
          AND NOT EXISTS (SELECT 1 FROM public.journal_entries o WHERE o.id = e.reverses_entry_id AND COALESCE(o.source_ref, '') LIKE 'allocation-%'))::bigint AS ytd_net
    FROM public.monthly_statements s, w WHERE s.property_id = _property AND s.period = _period AND s.status <> 'superseded')
  SELECT s.id, s.member_key, s.version, s.status,
    (s.data_snapshot->'capital'->>'closing_cents')::bigint, j.closing,
    (s.data_snapshot->'llc_month'->>'income_cents')::bigint, j.income,
    (s.data_snapshot->'llc_month'->>'expense_cents')::bigint, j.expense,
    (s.data_snapshot->'ytd'->'llc'->>'net_cents')::bigint, j.ytd_net,
    (s.data_snapshot->'capital'->>'closing_cents')::bigint = j.closing
      AND (s.data_snapshot->'llc_month'->>'income_cents')::bigint = j.income
      AND (s.data_snapshot->'llc_month'->>'expense_cents')::bigint = j.expense
      AND (s.data_snapshot->'ytd'->'llc'->>'net_cents')::bigint = j.ytd_net
  FROM public.monthly_statements s JOIN j ON j.id = s.id ORDER BY s.member_key, s.version;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 6. Access, and the notification type that can never be switched off
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE public.monthly_statements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.monthly_statements FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.monthly_statements TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.monthly_statements TO service_role;

-- The Manager reads all. An owner reads the statements of THEIR OWN capital account once issued (and the superseded versions): nothing
-- about an owner's standing, payments or votes is looked at.
DROP POLICY IF EXISTS "manager and the member read statements" ON public.monthly_statements;
CREATE POLICY "manager and the member read statements" ON public.monthly_statements FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (status IN ('issued', 'superseded') AND public.is_property_owner(auth.uid(), property_id)
        AND (member_key = auth.uid() OR member_key IN (SELECT b.id FROM public.buyer_accounts b WHERE b.auth_user_id = auth.uid())))
  );

-- Rev 48 floor: the statement notice goes to every owner whatever their preferences.
DO $$
DECLARE c record;
BEGIN
  IF to_regclass('public.owner_notification_preferences') IS NOT NULL THEN
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.owner_notification_preferences'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%governance_vote_window%' LOOP
      EXECUTE format('ALTER TABLE public.owner_notification_preferences DROP CONSTRAINT %I', c.conname);
    END LOOP;
    ALTER TABLE public.owner_notification_preferences DROP CONSTRAINT IF EXISTS owner_notification_preferences_floor;
    ALTER TABLE public.owner_notification_preferences ADD CONSTRAINT owner_notification_preferences_floor
      CHECK (email_enabled OR type NOT IN ('governance_vote_window', 'capital_call_alert', 'notice_posted', 'monthly_statement'));
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.monthly_statements_guard(), public.statement_audit(uuid, text, uuid, jsonb), public.statement_require_manager(uuid),
  public.statement_llc_activity(uuid, date, date, boolean), public.statement_capital(uuid, uuid, date, date), public.build_statement_snapshot(uuid, uuid, text), public.statement_hash(jsonb),
  public.generate_monthly_statements(uuid, text, uuid, jsonb), public.set_statement_notes(uuid, text, uuid, text, uuid, jsonb),
  public.issue_monthly_statements(uuid, text, uuid, text, jsonb), public.set_statement_pdf(uuid, text), public.statement_reconciliation(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.statement_llc_activity(uuid, date, date, boolean), public.statement_capital(uuid, uuid, date, date), public.build_statement_snapshot(uuid, uuid, text), public.statement_hash(jsonb),
  public.generate_monthly_statements(uuid, text, uuid, jsonb), public.set_statement_notes(uuid, text, uuid, text, uuid, jsonb),
  public.issue_monthly_statements(uuid, text, uuid, text, jsonb), public.set_statement_pdf(uuid, text), public.statement_reconciliation(uuid, text) TO service_role;
