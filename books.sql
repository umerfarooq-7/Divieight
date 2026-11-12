-- divieight — Month 6, Prompt 4: the Manager's working screens for the books (/admin/books/:propertyId).
--
-- Run in the Supabase SQL editor AFTER bookkeeping.sql, capital-accounts.sql and bank-feed.sql. Safe to run again.
--
-- Nothing here edits the journal. Every change is a new entry:
--   * post_bank_transaction / ignore_bank_transaction   the needs-review queue (a transaction can be split across accounts)
--   * post_manual_entry                                 a cash transaction that isn't in the bank feed, with a receipt
--   * recategorize_entry / capitalize_entry             a reversing entry plus a corrected one, linked in entry_corrections
--   * recurring_rules + apply_due_recurring             recurring expenses, one posting per rule per due date, each logged
--   * apply_rules_to_needs_review + rule functions      the categorization rules manager
--   * close_period (with the statement gate) / reopen_period   a month is reopened only with a reason, audit logged

-- ---------------------------------------------------------------------------------------------------------
-- 1. Periods: close after the statement, reopen with a reason
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accounting_period_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  year integer NOT NULL,
  month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  action text NOT NULL CHECK (action IN ('closed', 'reopened')),
  actor uuid,
  reason text,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (action <> 'reopened' OR (reason IS NOT NULL AND btrim(reason) <> ''))
);
CREATE INDEX IF NOT EXISTS accounting_period_events_idx ON public.accounting_period_events (property_id, year, month, at);

CREATE OR REPLACE FUNCTION public.period_events_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'The period history is append-only.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS period_events_guard_trg ON public.accounting_period_events;
CREATE TRIGGER period_events_guard_trg BEFORE UPDATE OR DELETE ON public.accounting_period_events FOR EACH ROW EXECUTE FUNCTION public.period_events_guard();
DROP TRIGGER IF EXISTS period_events_truncate_guard ON public.accounting_period_events;
CREATE TRIGGER period_events_truncate_guard BEFORE TRUNCATE ON public.accounting_period_events FOR EACH STATEMENT EXECUTE FUNCTION public.period_events_guard();
ALTER TABLE public.accounting_period_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_period_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.accounting_period_events TO authenticated, service_role;
DROP POLICY IF EXISTS "the Manager reads the period history" ON public.accounting_period_events;
CREATE POLICY "the Manager reads the period history" ON public.accounting_period_events FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- A closed period stays closed unless it is reopened through reopen_period (which sets the flag for its own statement).
CREATE OR REPLACE FUNCTION public.accounting_periods_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An accounting period is never deleted.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'closed' AND COALESCE(current_setting('app.period_reopen', true), '') <> 'on' THEN
    RAISE EXCEPTION 'A closed accounting period stays closed unless the Manager reopens it, with a reason.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Prompt 10 (the monthly statement) will add public.monthly_statements (property_id, year, month, generated_at). Until that
-- table exists a month may be closed; once it does, a month closes only after its statement has been generated.
CREATE OR REPLACE FUNCTION public.period_statement_ready(_property uuid, _year integer, _month integer)
RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  ready boolean;
BEGIN
  IF to_regclass('public.monthly_statements') IS NULL THEN
    RETURN true;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.monthly_statements WHERE property_id = $1 AND year = $2 AND month = $3 AND generated_at IS NOT NULL)' INTO ready USING _property, _year, _month;
  RETURN ready;
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
  IF NOT public.period_statement_ready(_property, _year, _month) THEN
    RAISE EXCEPTION 'The monthly statement for % has not been generated yet. Generate it, then close the month.', format('%s-%s', _year, lpad(_month::text, 2, '0')) USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.accounting_periods (property_id, year, month, status, closed_by, closed_at)
  VALUES (_property, _year, _month, 'closed', _by, clock_timestamp())
  ON CONFLICT (property_id, year, month) DO UPDATE SET status = 'closed', closed_by = EXCLUDED.closed_by, closed_at = EXCLUDED.closed_at;
  INSERT INTO public.accounting_period_events (property_id, year, month, action, actor) VALUES (_property, _year, _month, 'closed', _by);
  PERFORM public.ledger_audit(_by, 'ledger.period_closed', _property, jsonb_build_object('property_id', _property, 'period', format('%s-%s', _year, lpad(_month::text, 2, '0')), 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

CREATE OR REPLACE FUNCTION public.reopen_period(_property uuid, _year integer, _month integer, _by uuid, _reason text, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  why text := NULLIF(btrim(COALESCE(_reason, '')), '');
BEGIN
  IF _by IS NULL OR NOT public.has_role(_by, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can reopen a period.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF why IS NULL THEN
    RAISE EXCEPTION 'Say why this period is being reopened.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounting_periods WHERE property_id = _property AND year = _year AND month = _month AND status = 'closed') THEN
    RAISE EXCEPTION 'That period is not closed.' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.period_reopen', 'on', true);
  UPDATE public.accounting_periods SET status = 'open' WHERE property_id = _property AND year = _year AND month = _month;
  PERFORM set_config('app.period_reopen', 'off', true);
  INSERT INTO public.accounting_period_events (property_id, year, month, action, actor, reason) VALUES (_property, _year, _month, 'reopened', _by, why);
  PERFORM public.ledger_audit(_by, 'ledger.period_reopened', _property, jsonb_build_object('property_id', _property, 'period', format('%s-%s', _year, lpad(_month::text, 2, '0')), 'reason', why, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 2. Receipts (the private storage pattern) and the link from an entry to its corrections
-- ---------------------------------------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public) VALUES ('ledger-receipts', 'ledger-receipts', false) ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS "The Manager manages ledger receipts" ON storage.objects;
CREATE POLICY "The Manager manages ledger receipts" ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'ledger-receipts' AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (bucket_id = 'ledger-receipts' AND public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.ledger_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES public.journal_entries(id),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  storage_path text NOT NULL,
  file_name text NOT NULL,
  content_type text,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_attachments_entry_idx ON public.ledger_attachments (entry_id);
DROP TRIGGER IF EXISTS ledger_attachments_guard ON public.ledger_attachments;
CREATE TRIGGER ledger_attachments_guard BEFORE UPDATE OR DELETE ON public.ledger_attachments FOR EACH ROW EXECUTE FUNCTION public.period_events_guard();
ALTER TABLE public.ledger_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ledger_attachments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.ledger_attachments TO authenticated, service_role;
DROP POLICY IF EXISTS "the Manager reads receipts" ON public.ledger_attachments;
CREATE POLICY "the Manager reads receipts" ON public.ledger_attachments FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.entry_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  original_entry_id uuid NOT NULL REFERENCES public.journal_entries(id),
  reversal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id),
  corrected_entry_id uuid REFERENCES public.journal_entries(id),
  kind text NOT NULL CHECK (kind IN ('recategorize', 'capitalize', 'reverse')),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  actor uuid,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (original_entry_id)
);
DROP TRIGGER IF EXISTS entry_corrections_guard ON public.entry_corrections;
CREATE TRIGGER entry_corrections_guard BEFORE UPDATE OR DELETE ON public.entry_corrections FOR EACH ROW EXECUTE FUNCTION public.period_events_guard();
ALTER TABLE public.entry_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.entry_corrections FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.entry_corrections TO authenticated, service_role;
DROP POLICY IF EXISTS "the Manager reads corrections" ON public.entry_corrections;
CREATE POLICY "the Manager reads corrections" ON public.entry_corrections FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- ---------------------------------------------------------------------------------------------------------
-- 3. The needs-review queue
-- ---------------------------------------------------------------------------------------------------------
-- The account the rules would suggest for a transaction (the Manager still chooses).
CREATE OR REPLACE FUNCTION public.suggest_bank_account(_txn uuid)
RETURNS TABLE (code text, name text, rule_id uuid)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  t public.bank_transactions%ROWTYPE;
  r public.categorization_rules%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.bank_transactions WHERE id = _txn;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  r := public.match_categorization_rule(t);
  IF r.id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT a.code, a.name, r.id FROM public.coa_accounts a WHERE a.id = r.coa_account_id AND NOT a.is_member_control;
END;
$$;

-- Post a transaction the Manager has categorized, to one account or split across several (the cents must add up to the
-- transaction). _splits: [{ code | account_id, cents }]. Money out debits the accounts and credits Cash; money in the reverse.
CREATE OR REPLACE FUNCTION public.post_bank_transaction(_txn uuid, _splits jsonb, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.bank_transactions%ROWTYPE;
  s jsonb;
  total bigint := 0;
  n integer := 0;
  lines jsonb := '[]'::jsonb;
  c bigint;
  entry uuid;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can post a bank transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM public.bank_transactions WHERE id = _txn FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank transaction not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status NOT IN ('needs_review', 'new') OR t.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'This transaction is already %: reverse its entry to correct it.', t.status USING ERRCODE = 'check_violation';
  END IF;
  IF t.is_pending THEN
    RAISE EXCEPTION 'A pending transaction can''t be posted until the bank posts it.' USING ERRCODE = 'check_violation';
  END IF;
  IF t.direction = 'in' AND public.looks_like_str_revenue(t.merchant_name, t.description, t.raw_category) THEN
    RAISE EXCEPTION 'This looks like short-term-rental revenue. It is never posted to the LLC (COOA Section 10): mark it ignored with a reason.' USING ERRCODE = 'check_violation';
  END IF;
  IF _splits IS NULL OR jsonb_typeof(_splits) <> 'array' OR jsonb_array_length(_splits) < 1 THEN
    RAISE EXCEPTION 'Choose at least one account.' USING ERRCODE = 'check_violation';
  END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(_splits) LOOP
    n := n + 1;
    IF (s->>'cents') IS NULL OR (s->>'cents')::numeric <> floor((s->>'cents')::numeric) OR (s->>'cents')::numeric <= 0 THEN
      RAISE EXCEPTION 'Split %: the amount is a whole number of cents above zero.', n USING ERRCODE = 'check_violation';
    END IF;
    c := (s->>'cents')::bigint;
    total := total + c;
    lines := lines || jsonb_build_array(
      (CASE WHEN s ? 'account_id' THEN jsonb_build_object('account_id', s->>'account_id') ELSE jsonb_build_object('code', s->>'code') END)
      || CASE WHEN t.direction = 'out' THEN jsonb_build_object('debit_cents', c) ELSE jsonb_build_object('credit_cents', c) END);
  END LOOP;
  IF total <> t.amount_cents THEN
    RAISE EXCEPTION 'The splits add up to % cents but the transaction is % cents.', total, t.amount_cents USING ERRCODE = 'check_violation';
  END IF;
  lines := lines || jsonb_build_array(CASE WHEN t.direction = 'out' THEN jsonb_build_object('code', '1000', 'credit_cents', t.amount_cents) ELSE jsonb_build_object('code', '1000', 'debit_cents', t.amount_cents) END);

  entry := public.post_entry(t.property_id, lines, jsonb_build_object('source', 'plaid', 'source_ref', 'plaid:' || t.plaid_txn_id, 'entry_date', t.posted_date,
    'memo', COALESCE(t.merchant_name, t.description, 'Bank transaction') || CASE WHEN n > 1 THEN ' (split ' || n || ' ways)' ELSE '' END, 'created_by', _actor,
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  UPDATE public.bank_transactions SET status = 'posted', journal_entry_id = entry, review_reason = NULL WHERE id = t.id;
  PERFORM public.ledger_audit(_actor, 'books.bank_transaction_posted', entry, jsonb_build_object('property_id', t.property_id, 'bank_transaction_id', t.id, 'splits', n, 'amount_cents', t.amount_cents, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN entry;
END;
$$;

CREATE OR REPLACE FUNCTION public.ignore_bank_transaction(_txn uuid, _reason text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.bank_transactions%ROWTYPE;
  why text := NULLIF(btrim(COALESCE(_reason, '')), '');
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can ignore a bank transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF why IS NULL THEN
    RAISE EXCEPTION 'Say why this transaction is being ignored.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO t FROM public.bank_transactions WHERE id = _txn FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank transaction not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status NOT IN ('needs_review', 'new') OR t.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'This transaction is already %.', t.status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.bank_transactions SET status = 'ignored', review_reason = 'ignored: ' || why WHERE id = t.id;
  PERFORM public.ledger_audit(_actor, 'books.bank_transaction_ignored', t.id, jsonb_build_object('property_id', t.property_id, 'reason', why, 'amount_cents', t.amount_cents, 'direction', t.direction, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. Manual cash entries
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_manual_entry(_property uuid, _date date, _amount_cents bigint, _direction text, _account_code text, _memo text, _attachment jsonb, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  acct public.coa_accounts%ROWTYPE;
  ver public.coa_versions%ROWTYPE;
  entry uuid;
  note text := NULLIF(btrim(COALESCE(_memo, '')), '');
  path text := NULLIF(btrim(COALESCE(_attachment->>'path', '')), '');
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can post a manual entry.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF _date IS NULL OR _date > current_date THEN
    RAISE EXCEPTION 'Enter the date the cash moved (not in the future).' USING ERRCODE = 'check_violation';
  END IF;
  IF _amount_cents IS NULL OR _amount_cents <= 0 THEN
    RAISE EXCEPTION 'The amount is a whole number of cents above zero.' USING ERRCODE = 'check_violation';
  END IF;
  IF _direction NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'Say whether the cash went in or out.' USING ERRCODE = 'check_violation';
  END IF;
  IF note IS NULL THEN
    RAISE EXCEPTION 'A manual entry needs a memo.' USING ERRCODE = 'check_violation';
  END IF;
  IF _direction = 'in' AND public.looks_like_str_revenue(note, NULL, NULL) THEN
    RAISE EXCEPTION 'This looks like short-term-rental revenue. It is never posted to the LLC (COOA Section 10).' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO ver FROM public.coa_versions WHERE effective_from <= _date ORDER BY version DESC LIMIT 1;
  SELECT * INTO acct FROM public.coa_accounts WHERE version_id = ver.id AND code = _account_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That account doesn''t exist on the chart in force on %.', _date USING ERRCODE = 'no_data_found';
  END IF;
  IF acct.is_member_control OR acct.code = '1000' THEN
    RAISE EXCEPTION 'Choose the account the cash was for, not Cash or a member''s capital account.' USING ERRCODE = 'check_violation';
  END IF;
  IF path IS NOT NULL AND path NOT LIKE _property::text || '/%' THEN
    RAISE EXCEPTION 'The receipt must be stored under this property.' USING ERRCODE = 'check_violation';
  END IF;
  entry := public.post_entry(_property,
    CASE WHEN _direction = 'out' THEN jsonb_build_array(jsonb_build_object('code', acct.code, 'debit_cents', _amount_cents), jsonb_build_object('code', '1000', 'credit_cents', _amount_cents))
         ELSE jsonb_build_array(jsonb_build_object('code', '1000', 'debit_cents', _amount_cents), jsonb_build_object('code', acct.code, 'credit_cents', _amount_cents)) END,
    jsonb_build_object('source', 'manual', 'source_ref', 'manual:' || gen_random_uuid()::text, 'entry_date', _date, 'memo', note, 'created_by', _actor,
      'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent',
      'is_adjustment', COALESCE((_meta->>'is_adjustment')::boolean, false), 'adjustment_reason', _meta->>'adjustment_reason'));
  IF path IS NOT NULL THEN
    INSERT INTO public.ledger_attachments (entry_id, property_id, storage_path, file_name, content_type, uploaded_by)
    VALUES (entry, _property, path, COALESCE(NULLIF(_attachment->>'file_name', ''), 'receipt'), _attachment->>'content_type', _actor);
  END IF;
  PERFORM public.ledger_audit(_actor, 'books.manual_entry_posted', entry, jsonb_build_object('property_id', _property, 'amount_cents', _amount_cents, 'direction', _direction, 'account', acct.code, 'receipt', path IS NOT NULL, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN entry;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. Corrections: a reversing entry plus a corrected one. Nothing is edited.
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.correct_entry(_entry uuid, _new_lines jsonb, _reason text, _kind text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  orig public.journal_entries%ROWTYPE;
  why text := NULLIF(btrim(COALESCE(_reason, '')), '');
  entry_date date;
  meta jsonb;
  reversal uuid;
  corrected uuid;
  orig_total bigint;
  new_total bigint;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can correct an entry.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF why IS NULL THEN
    RAISE EXCEPTION 'Say why this entry is being corrected.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO orig FROM public.journal_entries WHERE id = _entry;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF orig.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'A reversal can''t be corrected.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE reverses_entry_id = _entry) THEN
    RAISE EXCEPTION 'This entry was already reversed.' USING ERRCODE = 'unique_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_lines WHERE entry_id = _entry AND member_id IS NOT NULL) THEN
    RAISE EXCEPTION 'An entry on a member''s capital account is corrected by reversing it, not recategorized.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(debit_cents), 0) INTO orig_total FROM public.journal_lines WHERE entry_id = _entry;
  SELECT COALESCE(sum((l->>'debit_cents')::bigint), 0) INTO new_total FROM jsonb_array_elements(_new_lines) l;
  IF new_total <> orig_total THEN
    RAISE EXCEPTION 'A correction keeps the amount: the corrected entry is % cents but the original was % cents.', new_total, orig_total USING ERRCODE = 'check_violation';
  END IF;

  entry_date := COALESCE((_meta->>'entry_date')::date, orig.entry_date);
  meta := jsonb_build_object('created_by', _actor, 'entry_date', entry_date, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent',
                             'is_adjustment', COALESCE((_meta->>'is_adjustment')::boolean, false), 'adjustment_reason', _meta->>'adjustment_reason');
  -- Both entries in one transaction: if the corrected entry is refused, the reversal is rolled back too.
  reversal := public.reverse_entry(_entry, _kind || ': ' || why, meta);
  corrected := public.post_entry(orig.property_id, _new_lines, meta || jsonb_build_object('source', 'manual', 'source_ref', 'correction:' || _entry::text,
    'memo', initcap(_kind) || ' of ' || _entry::text || ': ' || why));
  INSERT INTO public.entry_corrections (property_id, original_entry_id, reversal_entry_id, corrected_entry_id, kind, reason, actor)
  VALUES (orig.property_id, _entry, reversal, corrected, _kind, why, _actor);
  PERFORM public.ledger_audit(_actor, 'books.entry_' || _kind || 'd', corrected, jsonb_build_object('property_id', orig.property_id, 'original_entry_id', _entry, 'reversal_entry_id', reversal, 'corrected_entry_id', corrected, 'reason', why, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('reversal_entry_id', reversal, 'corrected_entry_id', corrected);
END;
$$;

-- Recategorize: move lines to other accounts. _mapping: { "<journal_lines.id>": "<new account code>" }. Everything else is as it was.
CREATE OR REPLACE FUNCTION public.recategorize_entry(_entry uuid, _mapping jsonb, _reason text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_lines jsonb;
BEGIN
  IF _mapping IS NULL OR jsonb_typeof(_mapping) <> 'object' OR _mapping = '{}'::jsonb THEN
    RAISE EXCEPTION 'Choose the account to move to.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(_mapping) k WHERE NOT EXISTS (SELECT 1 FROM public.journal_lines WHERE id = k::uuid AND entry_id = _entry)) THEN
    RAISE EXCEPTION 'A line to recategorize isn''t on this entry.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_lines l JOIN public.coa_accounts a ON a.id = l.account_id WHERE l.entry_id = _entry AND (_mapping ? l.id::text) AND a.code = '1000') THEN
    RAISE EXCEPTION 'The Cash line stays: recategorize the other side.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('code', COALESCE(_mapping->>l.id::text, a.code), 'debit_cents', l.debit_cents, 'credit_cents', l.credit_cents) ORDER BY l.id)
  INTO new_lines
  FROM public.journal_lines l JOIN public.coa_accounts a ON a.id = l.account_id WHERE l.entry_id = _entry;
  IF new_lines IS NULL THEN
    RAISE EXCEPTION 'Entry not found.' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN public.correct_entry(_entry, new_lines, _reason, 'recategorize', _actor, _meta);
END;
$$;

-- Capitalize: an expense becomes a capital asset (Furnishings and Capital Improvements). Reverse, then post it to the asset.
CREATE OR REPLACE FUNCTION public.capitalize_entry(_entry uuid, _reason text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_lines jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.journal_lines l JOIN public.coa_accounts a ON a.id = l.account_id WHERE l.entry_id = _entry AND a.type = 'expense' AND l.debit_cents > 0) THEN
    RAISE EXCEPTION 'Only an expense can be capitalized: this entry has no expense to move.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('code', CASE WHEN a.type = 'expense' AND l.debit_cents > 0 THEN '1210' ELSE a.code END, 'debit_cents', l.debit_cents, 'credit_cents', l.credit_cents) ORDER BY l.id)
  INTO new_lines
  FROM public.journal_lines l JOIN public.coa_accounts a ON a.id = l.account_id WHERE l.entry_id = _entry;
  RETURN public.correct_entry(_entry, new_lines, _reason, 'capitalize', _actor, _meta);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 6. Recurring expenses
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recurring_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  description text NOT NULL CHECK (btrim(description) <> ''),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  coa_account_id uuid NOT NULL REFERENCES public.coa_accounts(id),
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'annually')),
  anchor_day integer NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  next_run date NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recurring_rules_due_idx ON public.recurring_rules (next_run) WHERE active;

CREATE TABLE IF NOT EXISTS public.recurring_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES public.recurring_rules(id),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  run_date date NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'failed')),
  entry_id uuid REFERENCES public.journal_entries(id),
  error text,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- One posting per rule per due date, whatever runs the job and however often.
  UNIQUE (rule_id, run_date),
  CHECK ((status = 'posted') = (entry_id IS NOT NULL))
);

ALTER TABLE public.recurring_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_applications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recurring_rules, public.recurring_applications FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.recurring_rules, public.recurring_applications TO authenticated, service_role;
DROP POLICY IF EXISTS "the Manager reads recurring rules" ON public.recurring_rules;
CREATE POLICY "the Manager reads recurring rules" ON public.recurring_rules FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS "the Manager reads recurring applications" ON public.recurring_applications;
CREATE POLICY "the Manager reads recurring applications" ON public.recurring_applications FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.recurring_next_date(_from date, _frequency text, _anchor integer)
RETURNS date LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  months integer := CASE _frequency WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3 WHEN 'annually' THEN 12 ELSE 0 END;
  first_of date;
BEGIN
  IF _frequency = 'weekly' THEN
    RETURN _from + 7;
  END IF;
  first_of := (date_trunc('month', _from) + make_interval(months => months))::date;
  RETURN first_of + (LEAST(_anchor, extract(day FROM (first_of + interval '1 month' - interval '1 day'))::int) - 1);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_recurring_rule(_property uuid, _description text, _amount_cents bigint, _account_code text, _frequency text, _first_run date, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  acct public.coa_accounts%ROWTYPE;
  ver public.coa_versions%ROWTYPE;
  new_id uuid;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can set up a recurring expense.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = _property) THEN
    RAISE EXCEPTION 'Property not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF _first_run IS NULL THEN
    RAISE EXCEPTION 'Choose the first date it is due.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO ver FROM public.coa_versions WHERE effective_from <= GREATEST(_first_run, current_date) ORDER BY version DESC LIMIT 1;
  SELECT * INTO acct FROM public.coa_accounts WHERE version_id = ver.id AND code = _account_code AND active;
  IF NOT FOUND OR acct.is_member_control OR acct.type NOT IN ('expense', 'asset') OR acct.code = '1000' THEN
    RAISE EXCEPTION 'Choose an expense account for a recurring expense.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.recurring_rules (property_id, description, amount_cents, coa_account_id, frequency, anchor_day, next_run, created_by)
  VALUES (_property, btrim(_description), _amount_cents, acct.id, _frequency, extract(day FROM _first_run)::int, _first_run, _actor) RETURNING id INTO new_id;
  PERFORM public.ledger_audit(_actor, 'books.recurring_rule_created', new_id, jsonb_build_object('property_id', _property, 'description', btrim(_description), 'amount_cents', _amount_cents, 'account', acct.code, 'frequency', _frequency, 'first_run', _first_run, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_recurring_rule_active(_rule uuid, _active boolean, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can change a recurring expense.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.recurring_rules SET active = _active WHERE id = _rule;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recurring expense not found.' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public.ledger_audit(_actor, CASE WHEN _active THEN 'books.recurring_rule_resumed' ELSE 'books.recurring_rule_paused' END, _rule, jsonb_build_object('ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- The scheduled job. Posts every due date once (catching up a missed day, at most 24 per rule per call) and logs each
-- application. A date that already has an application is never posted again; one that failed is retried.
CREATE OR REPLACE FUNCTION public.apply_due_recurring(_as_of date DEFAULT current_date, _actor uuid DEFAULT NULL, _property uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.recurring_rules%ROWTYPE;
  acct public.coa_accounts%ROWTYPE;
  app public.recurring_applications%ROWTYPE;
  run date;
  guard integer;
  entry uuid;
  posted integer := 0;
  failed integer := 0;
  skipped integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('recurring-rules'));
  FOR r IN SELECT * FROM public.recurring_rules WHERE active AND next_run <= _as_of AND (_property IS NULL OR property_id = _property) ORDER BY next_run, id LOOP
    guard := 0;
    SELECT * INTO acct FROM public.coa_accounts WHERE id = r.coa_account_id;
    WHILE r.next_run <= _as_of AND guard < 24 LOOP
      guard := guard + 1;
      run := r.next_run;
      SELECT * INTO app FROM public.recurring_applications WHERE rule_id = r.id AND run_date = run;
      IF FOUND AND app.status = 'posted' THEN
        -- Already applied for this date: just move on.
        skipped := skipped + 1;
      ELSE
        BEGIN
          entry := public.post_entry(r.property_id,
            jsonb_build_array(jsonb_build_object('code', acct.code, 'debit_cents', r.amount_cents), jsonb_build_object('code', '1000', 'credit_cents', r.amount_cents)),
            jsonb_build_object('source', 'system', 'source_ref', 'recurring:' || r.id::text || ':' || run::text, 'entry_date', run, 'memo', r.description, 'created_by', NULL));
          IF app.id IS NOT NULL THEN
            DELETE FROM public.recurring_applications WHERE id = app.id AND status = 'failed';
          END IF;
          INSERT INTO public.recurring_applications (rule_id, property_id, run_date, status, entry_id) VALUES (r.id, r.property_id, run, 'posted', entry);
          PERFORM public.ledger_audit(_actor, 'ledger.recurring_applied', entry, jsonb_build_object('property_id', r.property_id, 'rule_id', r.id, 'run_date', run, 'description', r.description, 'amount_cents', r.amount_cents, 'account', acct.code));
          posted := posted + 1;
        EXCEPTION WHEN OTHERS THEN
          -- A closed period, a retired account: record it, leave the date due so it is retried, and stop this rule.
          INSERT INTO public.recurring_applications (rule_id, property_id, run_date, status, error)
          VALUES (r.id, r.property_id, run, 'failed', left(SQLERRM, 300))
          ON CONFLICT (rule_id, run_date) DO UPDATE SET error = EXCLUDED.error, applied_at = clock_timestamp() WHERE public.recurring_applications.status = 'failed';
          PERFORM public.ledger_audit(_actor, 'ledger.recurring_failed', r.id, jsonb_build_object('property_id', r.property_id, 'rule_id', r.id, 'run_date', run, 'error', left(SQLERRM, 300)));
          failed := failed + 1;
          EXIT;
        END;
      END IF;
      r.next_run := public.recurring_next_date(run, r.frequency, r.anchor_day);
      UPDATE public.recurring_rules SET next_run = r.next_run WHERE id = r.id;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('posted', posted, 'failed', failed, 'already_applied', skipped, 'as_of', _as_of);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 7. The categorization rules manager
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_categorization_rule(_property uuid, _match_type text, _pattern text, _account_code text, _priority integer, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  acct public.coa_accounts%ROWTYPE;
  ver public.coa_versions%ROWTYPE;
  pat text := btrim(COALESCE(_pattern, ''));
  new_id uuid;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can change the categorization rules.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pat = '' THEN
    RAISE EXCEPTION 'Enter what to match.' USING ERRCODE = 'check_violation';
  END IF;
  IF _match_type = 'amount_range' AND pat !~ '^\d+-\d+$' THEN
    RAISE EXCEPTION 'An amount range is two amounts in cents, like 10000-50000.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO ver FROM public.coa_versions ORDER BY version DESC LIMIT 1;
  SELECT * INTO acct FROM public.coa_accounts WHERE version_id = ver.id AND code = _account_code AND active;
  IF NOT FOUND OR acct.is_member_control THEN
    RAISE EXCEPTION 'Choose an account the rule can post to (not a member''s capital account).' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.categorization_rules (property_id, match_type, pattern, coa_account_id, priority, note)
  VALUES (_property, _match_type, pat, acct.id, COALESCE(_priority, 100), 'Added by the Manager') RETURNING id INTO new_id;
  PERFORM public.ledger_audit(_actor, 'books.rule_saved', new_id, jsonb_build_object('property_id', _property, 'match_type', _match_type, 'pattern', pat, 'account', acct.code, 'priority', COALESCE(_priority, 100), 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_categorization_rule_active(_rule uuid, _active boolean, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can change the categorization rules.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.categorization_rules SET active = _active WHERE id = _rule;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rule not found.' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public.ledger_audit(_actor, CASE WHEN _active THEN 'books.rule_enabled' ELSE 'books.rule_disabled' END, _rule, jsonb_build_object('ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- Run the rules over the transactions waiting for review. Anything that still doesn't match stays in the queue; the
-- short-term-rental guard and the money-in rule apply exactly as they do on the daily feed.
CREATE OR REPLACE FUNCTION public.apply_rules_to_needs_review(_property uuid, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t record;
  r jsonb;
  posted integer := 0;
  still integer := 0;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can apply the rules.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR t IN SELECT id FROM public.bank_transactions
           WHERE property_id = _property AND status = 'needs_review' AND journal_entry_id IS NULL AND NOT is_pending
             AND COALESCE(review_reason, '') NOT LIKE 'ignored:%' ORDER BY posted_date, ingested_at, id LOOP
    UPDATE public.bank_transactions SET status = 'new' WHERE id = t.id;
    r := public.categorize_bank_transaction(t.id);
    IF r->>'action' = 'posted' THEN posted := posted + 1; ELSE still := still + 1; END IF;
  END LOOP;
  PERFORM public.ledger_audit(_actor, 'books.rules_applied', _property, jsonb_build_object('property_id', _property, 'posted', posted, 'still_needs_review', still, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('posted', posted, 'still_needs_review', still);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 8. Who may call what: the server (service role) only. Every function checks the Manager itself.
-- ---------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.reopen_period(uuid, integer, integer, uuid, text, jsonb), public.period_statement_ready(uuid, integer, integer),
  public.suggest_bank_account(uuid), public.post_bank_transaction(uuid, jsonb, uuid, jsonb), public.ignore_bank_transaction(uuid, text, uuid, jsonb),
  public.post_manual_entry(uuid, date, bigint, text, text, text, jsonb, uuid, jsonb), public.correct_entry(uuid, jsonb, text, text, uuid, jsonb),
  public.recategorize_entry(uuid, jsonb, text, uuid, jsonb), public.capitalize_entry(uuid, text, uuid, jsonb), public.recurring_next_date(date, text, integer),
  public.create_recurring_rule(uuid, text, bigint, text, text, date, uuid, jsonb), public.set_recurring_rule_active(uuid, boolean, uuid, jsonb), public.apply_due_recurring(date, uuid, uuid),
  public.save_categorization_rule(uuid, text, text, text, integer, uuid, jsonb), public.set_categorization_rule_active(uuid, boolean, uuid, jsonb), public.apply_rules_to_needs_review(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_period(uuid, integer, integer, uuid, text, jsonb), public.period_statement_ready(uuid, integer, integer),
  public.suggest_bank_account(uuid), public.post_bank_transaction(uuid, jsonb, uuid, jsonb), public.ignore_bank_transaction(uuid, text, uuid, jsonb),
  public.post_manual_entry(uuid, date, bigint, text, text, text, jsonb, uuid, jsonb), public.correct_entry(uuid, jsonb, text, text, uuid, jsonb),
  public.recategorize_entry(uuid, jsonb, text, uuid, jsonb), public.capitalize_entry(uuid, text, uuid, jsonb), public.recurring_next_date(date, text, integer),
  public.create_recurring_rule(uuid, text, bigint, text, text, date, uuid, jsonb), public.set_recurring_rule_active(uuid, boolean, uuid, jsonb), public.apply_due_recurring(date, uuid, uuid),
  public.save_categorization_rule(uuid, text, text, text, integer, uuid, jsonb), public.set_categorization_rule_active(uuid, boolean, uuid, jsonb), public.apply_rules_to_needs_review(uuid, uuid, jsonb)
  TO service_role;
