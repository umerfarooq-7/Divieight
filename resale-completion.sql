-- Resale Shop completion and the Final Sync. Run once in the Supabase SQL editor,
-- AFTER resale-shop.sql. Safe to re-run. Only adds; the columns of cap_table_entries
-- and the Prompt 7 tables are unchanged.

CREATE TABLE IF NOT EXISTS public.resale_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.resale_listings(id) ON DELETE CASCADE,
  buyer_holder_key text NOT NULL,
  buyer_user_id uuid NOT NULL,
  price numeric NOT NULL,
  -- The ledger line for the technology-service fee. Nothing is charged or disbursed here.
  flat_fee numeric NOT NULL DEFAULT 500,
  status text NOT NULL DEFAULT 'pending_closing' CHECK (status IN ('pending_closing', 'completed', 'cancelled')),
  completed_at timestamptz,
  completed_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One live sale per listing: this is also what makes picking a winner one-time.
CREATE UNIQUE INDEX IF NOT EXISTS resale_transactions_one_live
  ON public.resale_transactions (listing_id) WHERE status IN ('pending_closing', 'completed');

CREATE TABLE IF NOT EXISTS public.cap_table_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  share_number integer NOT NULL,
  from_holder_type text NOT NULL,
  from_buyer_account_id uuid,
  from_seller_id uuid,
  to_holder_type text NOT NULL,
  to_buyer_account_id uuid,
  to_seller_id uuid,
  resale_transaction_id uuid NOT NULL REFERENCES public.resale_transactions(id) ON DELETE CASCADE,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid
);
-- A sale changes the cap table exactly once.
CREATE UNIQUE INDEX IF NOT EXISTS cap_table_history_one_per_sale ON public.cap_table_history (resale_transaction_id);
CREATE INDEX IF NOT EXISTS cap_table_history_property_idx ON public.cap_table_history (property_id, changed_at DESC);

-- For the Month 6 K-1 work. No figures live here.
CREATE TABLE IF NOT EXISTS public.tax_ready_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  holder_key text NOT NULL,
  share_number integer NOT NULL,
  tax_records_stale boolean NOT NULL DEFAULT true,
  needs_review boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, holder_key, share_number)
);

-- A flag for the CPA only: basis is never computed on this platform.
CREATE TABLE IF NOT EXISTS public.cpa_worksheet_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  resale_transaction_id uuid REFERENCES public.resale_transactions(id) ON DELETE CASCADE,
  flag_type text NOT NULL DEFAULT 'section_754_review',
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The Final Sync. One transaction: every change below happens, or none does.
CREATE OR REPLACE FUNCTION public.apply_resale_cap_table_sync(_transaction uuid, _actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.resale_transactions%ROWTYPE;
  l public.resale_listings%ROWTYPE;
  c public.cap_table_entries%ROWTYPE;
  current_key text;
  to_type text;
  to_buyer uuid;
  to_seller uuid;
  names text[] := '{}';
  lock_ends timestamptz := now() + interval '12 months';
BEGIN
  SELECT * INTO t FROM public.resale_transactions WHERE id = _transaction FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cap_table_history WHERE resale_transaction_id = t.id) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'already_applied');
  END IF;
  IF t.status <> 'completed' THEN
    RAISE EXCEPTION 'This sale is not completed' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO l FROM public.resale_listings WHERE id = t.listing_id FOR UPDATE;
  IF NOT FOUND OR l.status NOT IN ('rofr_exercised', 'open_market', 'sold') THEN
    RAISE EXCEPTION 'This listing is no longer for sale' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO c FROM public.cap_table_entries
  WHERE property_id = l.property_id AND share_number = l.share_number FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Share #% is not on the cap table', l.share_number USING ERRCODE = 'check_violation';
  END IF;
  current_key := CASE WHEN c.holder_type = 'retained_seller' THEN 'seller:' || c.seller_id::text ELSE c.buyer_account_id::text END;
  IF current_key IS DISTINCT FROM l.seller_holder_key THEN
    RAISE EXCEPTION 'Share #% is no longer held by the seller', l.share_number USING ERRCODE = 'check_violation';
  END IF;

  IF t.buyer_holder_key LIKE 'seller:%' THEN
    to_type := 'retained_seller';
    to_seller := substr(t.buyer_holder_key, 8)::uuid;
  ELSE
    to_type := 'buyer_account';
    to_buyer := t.buyer_holder_key::uuid;
    SELECT COALESCE(array_agg(m.full_name) FILTER (WHERE m.full_name IS NOT NULL AND m.full_name <> ''), '{}')
      INTO names FROM public.account_members m WHERE m.buyer_account_id = to_buyer;
  END IF;

  UPDATE public.cap_table_entries
  SET holder_type = to_type,
      buyer_account_id = to_buyer,
      seller_id = to_seller,
      account_member_names = names,
      acquisition_date = now(),
      retention_lock_started_at = now(),
      retention_lock_expires_at = lock_ends,
      updated_at = now()
  WHERE property_id = l.property_id AND share_number = l.share_number;

  INSERT INTO public.cap_table_history (
    property_id, share_number, from_holder_type, from_buyer_account_id, from_seller_id,
    to_holder_type, to_buyer_account_id, to_seller_id, resale_transaction_id, changed_by
  ) VALUES (
    l.property_id, l.share_number, c.holder_type, c.buyer_account_id, c.seller_id,
    to_type, to_buyer, to_seller, t.id, _actor
  );

  UPDATE public.resale_listings SET status = 'sold' WHERE id = l.id;

  -- Digital Keys carry a share count, so they follow the cap table.
  UPDATE public.co_owner_digital_keys
  SET shares = GREATEST(shares - 1, 0),
      status = CASE WHEN shares <= 1 THEN 'revoked' ELSE status END
  WHERE property_id = l.property_id AND holder_type = c.holder_type
    AND buyer_account_id IS NOT DISTINCT FROM c.buyer_account_id
    AND seller_id IS NOT DISTINCT FROM c.seller_id;
  UPDATE public.co_owner_digital_keys
  SET shares = shares + 1, status = 'active'
  WHERE property_id = l.property_id AND holder_type = to_type
    AND buyer_account_id IS NOT DISTINCT FROM to_buyer
    AND seller_id IS NOT DISTINCT FROM to_seller;
  IF NOT FOUND THEN
    INSERT INTO public.co_owner_digital_keys (property_id, holder_type, buyer_account_id, seller_id, shares, status)
    VALUES (l.property_id, to_type, to_buyer, to_seller, 1, 'active');
  END IF;

  -- A request by the old holder can't help the new one, and would block theirs.
  UPDATE public.retention_exceptions
  SET status = 'withdrawn', decided_at = now(), decision_note = 'The share was sold.'
  WHERE property_id = l.property_id AND share_number = l.share_number AND status = 'pending';

  INSERT INTO public.tax_ready_records (property_id, holder_key, share_number)
  VALUES (l.property_id, l.seller_holder_key, l.share_number), (l.property_id, t.buyer_holder_key, l.share_number)
  ON CONFLICT (property_id, holder_key, share_number)
  DO UPDATE SET tax_records_stale = true, needs_review = true, updated_at = now();

  INSERT INTO public.cpa_worksheet_flags (property_id, resale_transaction_id, note)
  VALUES (l.property_id, t.id, 'Share #' || l.share_number || ' changed hands. CPA to review a Section 754 election. No basis step-up is computed on this platform.');

  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, 'admin', 'cap_table.resale_synced', 'resale_transaction', t.id::text, jsonb_build_object(
    'property_id', l.property_id, 'share_number', l.share_number,
    'from_holder_key', l.seller_holder_key, 'to_holder_key', t.buyer_holder_key, 'retention_lock_expires_at', lock_ends
  ));

  RETURN jsonb_build_object('applied', true, 'property_id', l.property_id, 'share_number', l.share_number, 'retention_lock_expires_at', lock_ends);
END;
$$;

-- Completing and syncing are one step: if the sync can't run, the sale stays pending.
CREATE OR REPLACE FUNCTION public.complete_resale_transaction(_transaction uuid, _actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.resale_transactions%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.resale_transactions WHERE id = _transaction FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sale not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF t.status = 'cancelled' THEN
    RAISE EXCEPTION 'This sale was cancelled' USING ERRCODE = 'check_violation';
  END IF;
  IF t.status = 'pending_closing' THEN
    UPDATE public.resale_transactions SET status = 'completed', completed_at = now(), completed_by = _actor WHERE id = t.id;
  END IF;
  RETURN public.apply_resale_cap_table_sync(t.id, _actor);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_resale_cap_table_sync(uuid, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_resale_transaction(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_resale_cap_table_sync(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_resale_transaction(uuid, uuid) TO service_role;

-- Every write goes through the server functions. Admin only, except a holder's own sale.
GRANT SELECT ON public.resale_transactions, public.cap_table_history, public.tax_ready_records, public.cpa_worksheet_flags TO authenticated;
GRANT ALL ON public.resale_transactions, public.cap_table_history, public.tax_ready_records, public.cpa_worksheet_flags TO service_role;
ALTER TABLE public.resale_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cap_table_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_ready_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cpa_worksheet_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parties read resale transactions" ON public.resale_transactions;
CREATE POLICY "parties read resale transactions" ON public.resale_transactions
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR buyer_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.resale_listings l WHERE l.id = listing_id AND l.seller_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "admins read cap table history" ON public.cap_table_history;
CREATE POLICY "admins read cap table history" ON public.cap_table_history
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "admins read tax ready records" ON public.tax_ready_records;
CREATE POLICY "admins read tax ready records" ON public.tax_ready_records
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "admins read cpa worksheet flags" ON public.cpa_worksheet_flags;
CREATE POLICY "admins read cpa worksheet flags" ON public.cpa_worksheet_flags
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
