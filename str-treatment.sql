-- Month 6, Prompt 7: Short-Term Rental treatment (COOA Section 10). STR income belongs to the individual owner, never to the LLC.
-- Run in the Supabase SQL editor AFTER bookkeeping.sql, capital-accounts.sql, bank-feed.sql and books.sql. Safe to run again.
--
--   1. The ledger refuses STR revenue. A trigger on journal_lines runs inside post_entry (and every function that posts), so
--      nothing can credit an LLC income account for an entry that describes STR activity, whoever calls it.
--   2. reclassify_str_deposit: a deposit that looks like STR income can only be IGNORED or RECLASSIFIED (as the owner's own
--      money, not the LLC's). Never posted as LLC income.
--   3. owner_str_records: each owner's own recordkeeping for their own use weeks. It has no link to the journal, no trigger
--      that touches the ledger, and no function that sums it into anything an LLC report reads.
--   4. str_tracker_allowed: only properties whose usage (Intent profile) is short_term_rental offer the tracker.
--   5. lodging_tax_exposure: for the CPA Cooperation Worksheet. Lists WHO recorded STR activity with lodging tax owed or
--      unknown. No amounts are calculated, nothing is remitted.

-- ---------------------------------------------------------------------------------------------------------
-- 1. The guard
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refuse_str_llc_income()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  a public.coa_accounts%ROWTYPE;
  e public.journal_entries%ROWTYPE;
BEGIN
  IF NEW.credit_cents <= 0 THEN
    RETURN NEW;
  END IF;
  SELECT * INTO a FROM public.coa_accounts WHERE id = NEW.account_id;
  IF a.type IS DISTINCT FROM 'income' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO e FROM public.journal_entries WHERE id = NEW.entry_id;
  -- A reversal only undoes an entry already in the books.
  IF e.reverses_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF public.looks_like_str_revenue(e.memo, e.source_ref, NULL) THEN
    RAISE EXCEPTION 'STR income does not belong to the LLC. Short-term-rental income is the individual owner''s (COOA Section 10) and is never credited to an LLC revenue account.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS journal_lines_refuse_str_income ON public.journal_lines;
CREATE TRIGGER journal_lines_refuse_str_income BEFORE INSERT ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.refuse_str_llc_income();

-- ---------------------------------------------------------------------------------------------------------
-- 2. A deposit that looks like STR income: ignore it, or reclassify it as the owner's. Never post it.
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reclassify_str_deposit(_txn uuid, _reason text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
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
    RAISE EXCEPTION 'Only the Manager can reclassify a bank transaction.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF why IS NULL THEN
    RAISE EXCEPTION 'Say whose income this is and why it isn''t the LLC''s.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO t FROM public.bank_transactions WHERE id = _txn FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank transaction not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status NOT IN ('needs_review', 'new') OR t.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'This transaction is already %.', t.status USING ERRCODE = 'check_violation';
  END IF;
  IF t.direction <> 'in' OR NOT public.looks_like_str_revenue(t.merchant_name, t.description, t.raw_category) THEN
    RAISE EXCEPTION 'Only a deposit that looks like short-term-rental income is reclassified this way.' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.bank_transactions SET status = 'ignored', review_reason = 'reclassified: owner STR income, not the LLC''s. ' || why WHERE id = t.id;
  PERFORM public.ledger_audit(_actor, 'books.str_deposit_reclassified', t.id, jsonb_build_object('property_id', t.property_id, 'reason', why, 'amount_cents', t.amount_cents,
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. Does this property's Intent profile allow short-term rental?
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.str_tracker_allowed(_property uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE((SELECT usage_tag = 'short_term_rental' FROM public.properties WHERE id = _property), false);
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. The owner's own STR records. Recordkeeping only: no link to the journal, never aggregated into LLC reports.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.owner_str_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  member_key uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  nights integer NOT NULL CHECK (nights >= 0),
  gross_amount_cents bigint NOT NULL CHECK (gross_amount_cents >= 0),
  platform_fees_cents bigint NOT NULL DEFAULT 0 CHECK (platform_fees_cents >= 0),
  lodging_tax_status text NOT NULL DEFAULT 'unknown' CHECK (lodging_tax_status IN ('not_applicable', 'owed', 'remitted', 'unknown')),
  lodging_tax_note text CHECK (lodging_tax_note IS NULL OR char_length(lodging_tax_note) <= 1000),
  entered_by_member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (nights <= (period_end - period_start) + 1),
  CHECK (platform_fees_cents <= gross_amount_cents),
  CHECK (entered_by_member_id = member_key)
);
CREATE INDEX IF NOT EXISTS owner_str_records_property_idx ON public.owner_str_records (property_id, member_key, period_start);

ALTER TABLE public.owner_str_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.owner_str_records FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.owner_str_records TO authenticated, service_role;
-- An owner reads only their own records. Nobody else, the Manager included, reads the amounts.
DROP POLICY IF EXISTS "an owner reads their own STR records" ON public.owner_str_records;
CREATE POLICY "an owner reads their own STR records" ON public.owner_str_records FOR SELECT TO authenticated
  USING (public.is_property_owner(auth.uid(), property_id)
         AND (member_key = auth.uid() OR member_key IN (SELECT b.id FROM public.buyer_accounts b WHERE b.auth_user_id = auth.uid())));

CREATE OR REPLACE FUNCTION public.save_owner_str_record(
  _property uuid, _user uuid, _id uuid, _period_start date, _period_end date, _nights integer,
  _gross_cents bigint, _fees_cents bigint, _tax_status text, _tax_note text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  member uuid;
  note text := NULLIF(btrim(COALESCE(_tax_note, '')), '');
  new_id uuid;
BEGIN
  IF _user IS NULL THEN
    RAISE EXCEPTION 'Sign in to record your short-term-rental activity.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  member := public.capital_member_key(_property, _user);
  IF member IS NULL THEN
    RAISE EXCEPTION 'You don''t have ownership in that property.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.str_tracker_allowed(_property) THEN
    RAISE EXCEPTION 'This home''s intent profile doesn''t include short-term rental.' USING ERRCODE = 'check_violation';
  END IF;
  IF _id IS NULL THEN
    INSERT INTO public.owner_str_records (property_id, member_key, period_start, period_end, nights, gross_amount_cents, platform_fees_cents, lodging_tax_status, lodging_tax_note, entered_by_member_id)
    VALUES (_property, member, _period_start, _period_end, _nights, _gross_cents, COALESCE(_fees_cents, 0), COALESCE(_tax_status, 'unknown'), note, member)
    RETURNING id INTO new_id;
  ELSE
    UPDATE public.owner_str_records SET period_start = _period_start, period_end = _period_end, nights = _nights, gross_amount_cents = _gross_cents,
           platform_fees_cents = COALESCE(_fees_cents, 0), lodging_tax_status = COALESCE(_tax_status, 'unknown'), lodging_tax_note = note, updated_at = now()
     WHERE id = _id AND property_id = _property AND member_key = member
    RETURNING id INTO new_id;
    IF new_id IS NULL THEN
      RAISE EXCEPTION 'That record isn''t yours to change.' USING ERRCODE = 'no_data_found';
    END IF;
  END IF;
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_owner_str_record(_property uuid, _user uuid, _id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  member uuid := public.capital_member_key(_property, _user);
BEGIN
  IF member IS NULL THEN
    RAISE EXCEPTION 'You don''t have ownership in that property.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.owner_str_records WHERE id = _id AND property_id = _property AND member_key = member;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That record isn''t yours to remove.' USING ERRCODE = 'no_data_found';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. State and local lodging-tax exposure, for the CPA Cooperation Worksheet. Who, never how much.
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lodging_tax_exposure(_property uuid, _actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can read the lodging-tax flag.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('member_key', member_key, 'statuses', statuses, 'record_count', n) ORDER BY member_key::text)
      FROM (SELECT member_key, array_agg(DISTINCT lodging_tax_status ORDER BY lodging_tax_status) AS statuses, count(*) AS n
              FROM public.owner_str_records
             WHERE property_id = _property AND lodging_tax_status IN ('owed', 'unknown')
             GROUP BY member_key) x), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_str_llc_income(), public.reclassify_str_deposit(uuid, text, uuid, jsonb), public.str_tracker_allowed(uuid),
  public.save_owner_str_record(uuid, uuid, uuid, date, date, integer, bigint, bigint, text, text), public.delete_owner_str_record(uuid, uuid, uuid),
  public.lodging_tax_exposure(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclassify_str_deposit(uuid, text, uuid, jsonb), public.str_tracker_allowed(uuid),
  public.save_owner_str_record(uuid, uuid, uuid, date, date, integer, bigint, bigint, text, text), public.delete_owner_str_record(uuid, uuid, uuid),
  public.lodging_tax_exposure(uuid, uuid) TO service_role;
