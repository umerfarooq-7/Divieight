-- divieight — Month 6, Prompt 3: the daily bank feed for each LLC operating account.
--
-- Run in the Supabase SQL editor AFTER bookkeeping.sql and capital-accounts.sql. Safe to run again.
--
--   1. llc_plaid_consents: the LLC's OWN bank-feed consent, granted by divieight, LLC as Manager. A separate record and
--      flow from the buyer-side Block 1 consent (member_plaid_consents / buyer_accounts.plaid_*), which this never touches.
--      The Plaid item reference is stored encrypted. Revoking it stops ingestion: the database refuses new transactions
--      for a property with no active consent.
--   2. bank_transactions: one row per bank transaction, unique on plaid_txn_id. upsert_bank_transaction is idempotent
--      and turns a pending transaction into its posted version on the SAME row.
--   3. categorization_rules and categorize_bank_transaction: a match posts through post_entry (source 'plaid'); no match
--      goes to 'needs_review'. Money in is NEVER auto-posted to income, and anything that looks like short-term-rental
--      revenue is never posted to the LLC (COOA Section 10): it waits for the Manager.
--   4. bank_reconciliation: bank balance against the ledger Cash balance, with what is unmatched.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Consent
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.llc_plaid_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  -- The Manager's user. The consent itself is divieight, LLC's, as Manager of the property LLC.
  granted_by_manager_user_id uuid NOT NULL,
  granted_by_entity text NOT NULL DEFAULT 'divieight, LLC as Manager',
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  -- Encrypted (AES-256-GCM, W9_TIN_ENCRYPTION_KEY): { ciphertext, iv, auth_tag, key_version }. Never plaintext.
  plaid_item_ref jsonb NOT NULL,
  institution_name text,
  account_mask text,
  scope text NOT NULL DEFAULT 'transactions:read',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  provider text NOT NULL DEFAULT 'plaid_sandbox',
  last_ingested_through date,
  bank_balance_cents bigint,
  bank_balance_at timestamptz,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (jsonb_typeof(plaid_item_ref) = 'object' AND plaid_item_ref ? 'ciphertext')
);
CREATE UNIQUE INDEX IF NOT EXISTS llc_plaid_consents_one_active ON public.llc_plaid_consents (property_id) WHERE status = 'active';

-- A consent is never deleted, and only its revocation (and the feed's bookkeeping) ever changes.
CREATE OR REPLACE FUNCTION public.llc_consent_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A bank-feed consent is never deleted: revoke it.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'A revoked consent stays revoked: link the account again for a new one.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.property_id <> OLD.property_id OR NEW.granted_by_manager_user_id <> OLD.granted_by_manager_user_id OR NEW.granted_at <> OLD.granted_at
     OR NEW.plaid_item_ref <> OLD.plaid_item_ref OR NEW.scope <> OLD.scope THEN
    RAISE EXCEPTION 'A consent''s grant can''t be edited: revoke it and link again.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS llc_consent_guard_trg ON public.llc_plaid_consents;
CREATE TRIGGER llc_consent_guard_trg BEFORE UPDATE OR DELETE ON public.llc_plaid_consents FOR EACH ROW EXECUTE FUNCTION public.llc_consent_guard();

ALTER TABLE public.llc_plaid_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.llc_plaid_consents FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT (id, property_id, granted_by_manager_user_id, granted_by_entity, granted_at, revoked_at, revoked_by, institution_name, account_mask, scope, status, provider, last_ingested_through, bank_balance_cents, bank_balance_at) ON public.llc_plaid_consents TO authenticated, service_role;
DROP POLICY IF EXISTS "the Manager reads the LLC bank-feed consents" ON public.llc_plaid_consents;
CREATE POLICY "the Manager reads the LLC bank-feed consents" ON public.llc_plaid_consents FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- The encrypted item reference is read by the server (service role) and nobody else.
GRANT SELECT (plaid_item_ref) ON public.llc_plaid_consents TO service_role;

CREATE OR REPLACE FUNCTION public.llc_consent_active(_property uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.llc_plaid_consents WHERE property_id = _property AND status = 'active');
$$;

CREATE OR REPLACE FUNCTION public.grant_llc_plaid_consent(_property uuid, _actor uuid, _item jsonb, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can link an LLC operating account.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = _property) THEN
    RAISE EXCEPTION 'Property not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF public.llc_consent_active(_property) THEN
    RAISE EXCEPTION 'This LLC already has an operating account linked. Revoke it first.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.llc_plaid_consents (property_id, granted_by_manager_user_id, plaid_item_ref, institution_name, account_mask, provider, scope)
  VALUES (_property, _actor, _item->'plaid_item_ref', _item->>'institution_name', _item->>'account_mask', COALESCE(_item->>'provider', 'plaid_sandbox'), COALESCE(_item->>'scope', 'transactions:read'))
  RETURNING id INTO new_id;
  PERFORM public.ledger_audit(_actor, 'bank_feed.consent_granted', new_id, jsonb_build_object('property_id', _property, 'entity', 'divieight, LLC as Manager', 'institution', _item->>'institution_name', 'account_mask', _item->>'account_mask', 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_llc_plaid_consent(_consent uuid, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.llc_plaid_consents%ROWTYPE;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can revoke a bank-feed consent.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO c FROM public.llc_plaid_consents WHERE id = _consent;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consent not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF c.status = 'revoked' THEN
    RAISE EXCEPTION 'That consent is already revoked.' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.llc_plaid_consents SET status = 'revoked', revoked_at = now(), revoked_by = _actor WHERE id = _consent;
  PERFORM public.ledger_audit(_actor, 'bank_feed.consent_revoked', _consent, jsonb_build_object('property_id', c.property_id, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- The feed's own bookkeeping after a run (the only change besides revoking).
CREATE OR REPLACE FUNCTION public.record_bank_feed_position(_property uuid, _through date, _balance_cents bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.llc_plaid_consents SET last_ingested_through = GREATEST(COALESCE(last_ingested_through, _through), _through), bank_balance_cents = COALESCE(_balance_cents, bank_balance_cents), bank_balance_at = CASE WHEN _balance_cents IS NULL THEN bank_balance_at ELSE now() END
  WHERE property_id = _property AND status = 'active';
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 2. Transactions
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  plaid_txn_id text NOT NULL UNIQUE,
  posted_date date NOT NULL,
  -- Always positive; direction says which way the money went.
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  merchant_name text,
  raw_category text,
  description text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'categorized', 'needs_review', 'posted', 'ignored')),
  is_pending boolean NOT NULL DEFAULT false,
  -- Ids this record had while it was pending: if the bank sends one again, it is the same record, not a new one.
  replaced_plaid_txn_ids text[] NOT NULL DEFAULT '{}',
  review_reason text,
  rule_id uuid,
  journal_entry_id uuid REFERENCES public.journal_entries(id),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'posted') = (journal_entry_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS bank_transactions_property_idx ON public.bank_transactions (property_id, status, posted_date);

-- One ledger entry per bank transaction, whatever happens twice.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_plaid_posting ON public.journal_entries (property_id, source_ref) WHERE source = 'plaid' AND reverses_entry_id IS NULL;

ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bank_transactions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.bank_transactions TO authenticated, service_role;
DROP POLICY IF EXISTS "the Manager reads bank transactions" ON public.bank_transactions;
CREATE POLICY "the Manager reads bank transactions" ON public.bank_transactions FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Nothing deletes a bank transaction; only the functions below change one.
CREATE OR REPLACE FUNCTION public.bank_transactions_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A bank transaction is never deleted: ignore it.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.journal_entry_id IS NOT NULL AND (NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id OR NEW.amount_cents <> OLD.amount_cents OR NEW.direction <> OLD.direction OR NEW.posted_date <> OLD.posted_date) THEN
    RAISE EXCEPTION 'A transaction already posted to the ledger can''t be changed: reverse its entry instead.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS bank_transactions_guard_trg ON public.bank_transactions;
CREATE TRIGGER bank_transactions_guard_trg BEFORE UPDATE OR DELETE ON public.bank_transactions FOR EACH ROW EXECUTE FUNCTION public.bank_transactions_guard();

-- Idempotent. _txn: { plaid_txn_id, pending_txn_id?, posted_date, amount_cents (positive), direction, merchant_name, raw_category, description, pending }
-- Returns { action: inserted | updated | pending_to_posted | unchanged | refused_after_posting, id }.
CREATE OR REPLACE FUNCTION public.upsert_bank_transaction(_property uuid, _txn jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tid text := NULLIF(btrim(COALESCE(_txn->>'plaid_txn_id', '')), '');
  pending_id text := NULLIF(btrim(COALESCE(_txn->>'pending_txn_id', '')), '');
  amt bigint := (_txn->>'amount_cents')::bigint;
  dir text := _txn->>'direction';
  pend boolean := COALESCE((_txn->>'pending')::boolean, false);
  d date := (_txn->>'posted_date')::date;
  cur public.bank_transactions%ROWTYPE;
  new_id uuid;
BEGIN
  IF NOT public.llc_consent_active(_property) THEN
    RAISE EXCEPTION 'This LLC has no active bank-feed consent: nothing is ingested.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF tid IS NULL OR amt IS NULL OR amt <= 0 OR dir NOT IN ('in', 'out') OR d IS NULL THEN
    RAISE EXCEPTION 'A bank transaction needs an id, a date, a positive amount in cents and a direction.' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bank:' || COALESCE(pending_id, tid)));

  SELECT * INTO cur FROM public.bank_transactions WHERE property_id = _property AND (plaid_txn_id = tid OR tid = ANY (replaced_plaid_txn_ids));
  IF FOUND AND cur.plaid_txn_id <> tid AND pend THEN
    -- A stale copy of the pending version, delivered after it posted.
    RETURN jsonb_build_object('action', 'unchanged', 'id', cur.id);
  END IF;
  IF NOT FOUND AND pending_id IS NOT NULL THEN
    -- The bank replaced a pending transaction with its posted version: the same record, not a second one.
    SELECT * INTO cur FROM public.bank_transactions WHERE plaid_txn_id = pending_id;
    IF FOUND THEN
      IF cur.journal_entry_id IS NOT NULL THEN
        RETURN jsonb_build_object('action', 'refused_after_posting', 'id', cur.id);
      END IF;
      UPDATE public.bank_transactions SET replaced_plaid_txn_ids = replaced_plaid_txn_ids || cur.plaid_txn_id, plaid_txn_id = tid, posted_date = d, amount_cents = amt, direction = dir, merchant_name = _txn->>'merchant_name', raw_category = _txn->>'raw_category',
        description = _txn->>'description', is_pending = pend, status = CASE WHEN status IN ('ignored', 'needs_review') THEN status ELSE 'new' END WHERE id = cur.id;
      RETURN jsonb_build_object('action', 'pending_to_posted', 'id', cur.id);
    END IF;
  END IF;

  IF FOUND THEN
    IF cur.journal_entry_id IS NOT NULL THEN
      RETURN jsonb_build_object('action', CASE WHEN cur.amount_cents = amt AND cur.direction = dir AND cur.posted_date = d THEN 'unchanged' ELSE 'refused_after_posting' END, 'id', cur.id);
    END IF;
    IF cur.posted_date = d AND cur.amount_cents = amt AND cur.direction = dir AND cur.is_pending = pend AND cur.merchant_name IS NOT DISTINCT FROM (_txn->>'merchant_name') AND cur.description IS NOT DISTINCT FROM (_txn->>'description') THEN
      RETURN jsonb_build_object('action', 'unchanged', 'id', cur.id);
    END IF;
    UPDATE public.bank_transactions SET posted_date = d, amount_cents = amt, direction = dir, merchant_name = _txn->>'merchant_name', raw_category = _txn->>'raw_category', description = _txn->>'description', is_pending = pend WHERE id = cur.id;
    RETURN jsonb_build_object('action', 'updated', 'id', cur.id);
  END IF;

  INSERT INTO public.bank_transactions (property_id, plaid_txn_id, posted_date, amount_cents, direction, merchant_name, raw_category, description, is_pending)
  VALUES (_property, tid, d, amt, dir, _txn->>'merchant_name', _txn->>'raw_category', _txn->>'description', pend) RETURNING id INTO new_id;
  RETURN jsonb_build_object('action', 'inserted', 'id', new_id);
END;
$$;

-- A transaction the bank took back (a pending one that never posted): ignored, never deleted.
CREATE OR REPLACE FUNCTION public.remove_bank_transaction(_property uuid, _plaid_txn_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cur public.bank_transactions%ROWTYPE;
BEGIN
  IF NOT public.llc_consent_active(_property) THEN
    RAISE EXCEPTION 'This LLC has no active bank-feed consent: nothing is ingested.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO cur FROM public.bank_transactions WHERE property_id = _property AND plaid_txn_id = _plaid_txn_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'unknown');
  END IF;
  IF cur.journal_entry_id IS NOT NULL THEN
    UPDATE public.bank_transactions SET review_reason = 'removed_by_bank_after_posting' WHERE id = cur.id;
    RETURN jsonb_build_object('action', 'flagged', 'id', cur.id);
  END IF;
  UPDATE public.bank_transactions SET status = 'ignored', review_reason = 'removed_by_bank' WHERE id = cur.id AND status <> 'ignored';
  RETURN jsonb_build_object('action', 'ignored', 'id', cur.id);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Categorization
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.categorization_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = a global rule, for every property.
  property_id uuid REFERENCES public.properties(id),
  match_type text NOT NULL CHECK (match_type IN ('merchant', 'keyword', 'amount_range')),
  -- merchant / keyword: text to find (case-insensitive). amount_range: 'min-max' in cents, e.g. '10000-50000'.
  pattern text NOT NULL CHECK (btrim(pattern) <> ''),
  coa_account_id uuid NOT NULL REFERENCES public.coa_accounts(id),
  -- Lower runs first. A property's own rule beats a global one at the same priority.
  priority integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS categorization_rules_unique ON public.categorization_rules (COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid), match_type, lower(pattern));
ALTER TABLE public.categorization_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.categorization_rules FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.categorization_rules TO authenticated, service_role;
GRANT INSERT, UPDATE ON public.categorization_rules TO service_role;
DROP POLICY IF EXISTS "the Manager reads the rules" ON public.categorization_rules;
CREATE POLICY "the Manager reads the rules" ON public.categorization_rules FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Sensible global rules on the version 1 chart. Money out only matters here; money in is never auto-posted to income.
DO $$
DECLARE
  v uuid;
  r record;
  acct uuid;
BEGIN
  SELECT id INTO v FROM public.coa_versions WHERE version = 1;
  IF v IS NULL THEN
    RETURN;
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('6000', 10, 'property tax'), ('6000', 10, 'county treasurer'), ('6000', 10, 'tax collector'),
    ('6110', 15, 'umbrella'),
    ('6100', 20, 'insurance'), ('6100', 20, 'state farm'), ('6100', 20, 'allstate'), ('6100', 20, 'farmers ins'), ('6100', 20, 'liberty mutual'), ('6100', 20, 'travelers'), ('6100', 20, 'hazard'),
    ('6200', 30, 'hoa'), ('6200', 30, 'homeowners assoc'), ('6200', 30, 'association dues'), ('6200', 30, 'community assoc'),
    ('6500', 35, 'management fee'), ('6500', 35, 'property management'),
    ('6300', 40, 'electric'), ('6300', 40, 'water dept'), ('6300', 40, 'water utilit'), ('6300', 40, 'sewer'), ('6300', 40, 'utilities'), ('6300', 40, 'natural gas'), ('6300', 40, 'trash'), ('6300', 40, 'waste management'), ('6300', 40, 'xfinity'), ('6300', 40, 'comcast'), ('6300', 40, 'internet'),
    ('6600', 50, 'cleaning'), ('6600', 50, 'maid'), ('6600', 50, 'turnover'), ('6600', 50, 'housekeeping'), ('6600', 50, 'laundry'),
    ('6400', 60, 'repair'), ('6400', 60, 'plumb'), ('6400', 60, 'hvac'), ('6400', 60, 'roofing'), ('6400', 60, 'handyman'), ('6400', 60, 'electrician'), ('6400', 60, 'home depot'), ('6400', 60, 'lowe''s'), ('6400', 60, 'maintenance')
  ) AS t(code, prio, pat) LOOP
    SELECT id INTO acct FROM public.coa_accounts WHERE version_id = v AND code = r.code;
    IF acct IS NOT NULL THEN
      INSERT INTO public.categorization_rules (property_id, match_type, pattern, coa_account_id, priority, note)
      VALUES (NULL, 'keyword', r.pat, acct, r.prio, 'Standard global rule')
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END;
$$;

-- What a short-term-rental payout looks like. Kept in step with STR_REVENUE_HINTS in src/lib/bank-feed.ts (a test compares them).
CREATE OR REPLACE FUNCTION public.looks_like_str_revenue(_merchant text, _description text, _category text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT lower(COALESCE(_merchant, '') || ' ' || COALESCE(_description, '') || ' ' || COALESCE(_category, '')) ~ '(airbnb|vrbo|homeaway|booking\.com|guesty|hostaway|lodgify|turno payout|guest payout|rental income|rental revenue|str revenue|short.term rental|nightly rate|reservation payout)';
$$;

-- Try the rules in order. Returns the matching rule row, or none.
CREATE OR REPLACE FUNCTION public.match_categorization_rule(_txn public.bank_transactions)
RETURNS public.categorization_rules
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  rule public.categorization_rules%ROWTYPE;
  hay text := lower(COALESCE(_txn.merchant_name, '') || ' ' || COALESCE(_txn.description, ''));
  lo bigint;
  hi bigint;
BEGIN
  FOR rule IN
    SELECT * FROM public.categorization_rules
    WHERE active AND (property_id = _txn.property_id OR property_id IS NULL)
    ORDER BY priority ASC, (property_id IS NULL) ASC, created_at ASC, id ASC
  LOOP
    IF rule.match_type = 'merchant' AND lower(COALESCE(_txn.merchant_name, '')) = lower(btrim(rule.pattern)) THEN
      RETURN rule;
    ELSIF rule.match_type = 'keyword' AND position(lower(btrim(rule.pattern)) IN hay) > 0 THEN
      RETURN rule;
    ELSIF rule.match_type = 'amount_range' AND rule.pattern ~ '^\s*\d+\s*-\s*\d+\s*$' THEN
      lo := split_part(rule.pattern, '-', 1)::bigint;
      hi := split_part(rule.pattern, '-', 2)::bigint;
      IF _txn.amount_cents BETWEEN lo AND hi THEN
        RETURN rule;
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- Categorize one transaction: post it through post_entry when a rule matches, otherwise send it for review.
CREATE OR REPLACE FUNCTION public.categorize_bank_transaction(_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.bank_transactions%ROWTYPE;
  rule public.categorization_rules%ROWTYPE;
  acct public.coa_accounts%ROWTYPE;
  entry uuid;
  lines jsonb;
  ref text;
BEGIN
  SELECT * INTO t FROM public.bank_transactions WHERE id = _id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank transaction not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status <> 'new' OR t.is_pending THEN
    RETURN jsonb_build_object('action', 'skipped', 'status', t.status);
  END IF;

  -- Short-term-rental revenue never goes to the LLC (COOA Section 10). It waits for the Manager.
  IF t.direction = 'in' AND public.looks_like_str_revenue(t.merchant_name, t.description, t.raw_category) THEN
    UPDATE public.bank_transactions SET status = 'needs_review', review_reason = 'looks_like_str_revenue' WHERE id = t.id;
    RETURN jsonb_build_object('action', 'needs_review', 'reason', 'looks_like_str_revenue');
  END IF;

  rule := public.match_categorization_rule(t);
  IF rule.id IS NULL THEN
    UPDATE public.bank_transactions SET status = 'needs_review', review_reason = CASE WHEN t.direction = 'in' THEN 'money_in_unknown_source' ELSE 'no_matching_rule' END WHERE id = t.id;
    RETURN jsonb_build_object('action', 'needs_review', 'reason', CASE WHEN t.direction = 'in' THEN 'money_in_unknown_source' ELSE 'no_matching_rule' END);
  END IF;
  SELECT * INTO acct FROM public.coa_accounts WHERE id = rule.coa_account_id;

  -- Money in is only ever a refund of an expense. Never income, never a member's account.
  IF acct.is_member_control OR (t.direction = 'in' AND acct.type <> 'expense') OR (t.direction = 'out' AND acct.type IN ('income')) THEN
    UPDATE public.bank_transactions SET status = 'needs_review', rule_id = rule.id, review_reason = CASE WHEN t.direction = 'in' THEN 'money_in_not_an_expense_refund' ELSE 'rule_account_not_postable' END WHERE id = t.id;
    RETURN jsonb_build_object('action', 'needs_review', 'reason', CASE WHEN t.direction = 'in' THEN 'money_in_not_an_expense_refund' ELSE 'rule_account_not_postable' END);
  END IF;

  ref := 'plaid:' || t.plaid_txn_id;
  -- The account is named by code so the chart version in force on the date is the one used.
  lines := CASE WHEN t.direction = 'out'
    THEN jsonb_build_array(jsonb_build_object('code', acct.code, 'debit_cents', t.amount_cents), jsonb_build_object('code', '1000', 'credit_cents', t.amount_cents))
    ELSE jsonb_build_array(jsonb_build_object('code', '1000', 'debit_cents', t.amount_cents), jsonb_build_object('code', acct.code, 'credit_cents', t.amount_cents)) END;
  BEGIN
    entry := public.post_entry(t.property_id, lines, jsonb_build_object('source', 'plaid', 'source_ref', ref, 'entry_date', t.posted_date,
      'memo', CASE WHEN t.direction = 'in' THEN 'Refund: ' ELSE '' END || COALESCE(t.merchant_name, t.description, 'Bank transaction'), 'created_by', NULL));
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.bank_transactions SET status = 'needs_review', rule_id = rule.id, review_reason = 'ledger_refused: ' || left(SQLERRM, 200) WHERE id = t.id;
    RETURN jsonb_build_object('action', 'needs_review', 'reason', 'ledger_refused');
  END;
  UPDATE public.bank_transactions SET status = 'posted', journal_entry_id = entry, rule_id = rule.id, review_reason = NULL WHERE id = t.id;
  RETURN jsonb_build_object('action', 'posted', 'entry_id', entry, 'rule_id', rule.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.categorize_new_bank_transactions(_property uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t record;
  r jsonb;
  posted integer := 0;
  review integer := 0;
BEGIN
  IF NOT public.llc_consent_active(_property) THEN
    RAISE EXCEPTION 'This LLC has no active bank-feed consent: nothing is ingested.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR t IN SELECT id FROM public.bank_transactions WHERE property_id = _property AND status = 'new' AND NOT is_pending ORDER BY posted_date, ingested_at, id LOOP
    r := public.categorize_bank_transaction(t.id);
    IF r->>'action' = 'posted' THEN posted := posted + 1; ELSIF r->>'action' = 'needs_review' THEN review := review + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('posted', posted, 'needs_review', review);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. Reconciliation
-- ---------------------------------------------------------------------------------------------------------
-- Bank balance against the ledger's Cash (account 1000), with what is unmatched. unreconciled = the part of the gap that
-- is NOT explained by posted bank transactions the ledger doesn't have yet.
CREATE OR REPLACE VIEW public.bank_reconciliation WITH (security_invoker = true) AS
SELECT c.property_id, c.id AS consent_id, c.bank_balance_cents, c.bank_balance_at, c.last_ingested_through,
       COALESCE(cash.cents, 0)::bigint AS ledger_cash_cents,
       (c.bank_balance_cents - COALESCE(cash.cents, 0))::bigint AS difference_cents,
       COALESCE(u.count_open, 0)::integer AS unmatched_count,
       COALESCE(u.in_cents, 0)::bigint AS unmatched_in_cents,
       COALESCE(u.out_cents, 0)::bigint AS unmatched_out_cents,
       COALESCE(u.review_count, 0)::integer AS needs_review_count,
       COALESCE(p.pending_count, 0)::integer AS pending_count,
       (c.bank_balance_cents - COALESCE(cash.cents, 0) - (COALESCE(u.in_cents, 0) - COALESCE(u.out_cents, 0)))::bigint AS unreconciled_cents
FROM public.llc_plaid_consents c
LEFT JOIN LATERAL (
  SELECT sum(l.debit_cents - l.credit_cents) AS cents
  FROM public.journal_entries e JOIN public.journal_lines l ON l.entry_id = e.id JOIN public.coa_accounts a ON a.id = l.account_id
  WHERE e.property_id = c.property_id AND a.code = '1000'
) cash ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS count_open, sum(amount_cents) FILTER (WHERE direction = 'in') AS in_cents, sum(amount_cents) FILTER (WHERE direction = 'out') AS out_cents,
         count(*) FILTER (WHERE status = 'needs_review') AS review_count
  FROM public.bank_transactions b WHERE b.property_id = c.property_id AND b.status IN ('new', 'categorized', 'needs_review') AND NOT b.is_pending
) u ON true
LEFT JOIN LATERAL (SELECT count(*) AS pending_count FROM public.bank_transactions b WHERE b.property_id = c.property_id AND b.is_pending AND b.status <> 'ignored') p ON true
WHERE c.status = 'active';
REVOKE ALL ON public.bank_reconciliation FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bank_reconciliation TO service_role;

REVOKE ALL ON FUNCTION public.grant_llc_plaid_consent(uuid, uuid, jsonb, jsonb), public.revoke_llc_plaid_consent(uuid, uuid, jsonb), public.record_bank_feed_position(uuid, date, bigint),
  public.upsert_bank_transaction(uuid, jsonb), public.remove_bank_transaction(uuid, text), public.categorize_bank_transaction(uuid), public.categorize_new_bank_transactions(uuid),
  public.llc_consent_active(uuid), public.match_categorization_rule(public.bank_transactions), public.looks_like_str_revenue(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_llc_plaid_consent(uuid, uuid, jsonb, jsonb), public.revoke_llc_plaid_consent(uuid, uuid, jsonb), public.record_bank_feed_position(uuid, date, bigint),
  public.upsert_bank_transaction(uuid, jsonb), public.remove_bank_transaction(uuid, text), public.categorize_bank_transaction(uuid), public.categorize_new_bank_transactions(uuid),
  public.llc_consent_active(uuid), public.match_categorization_rule(public.bank_transactions), public.looks_like_str_revenue(text, text, text) TO service_role;
