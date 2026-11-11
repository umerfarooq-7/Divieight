-- Founder role, contribution types, and distributions by record date. Run once in the Supabase SQL editor, AFTER
-- governance-decisions.sql (which adds the 'founder' role value), expenses.sql, owner-notifications.sql and
-- resale-completion.sql. Safe to re-run.
--
--  1. The main admin becomes the founder (the earliest admin account). Add or change founders with user_roles.
--  2. Every confirmed expense or capital-call payment is recorded as a tagged contribution ('expense' or 'capital_call')
--     in owner_capital_contributions, alongside the unchanged running total in owner_capital_accounts. Existing
--     confirmed payments are backfilled, so the CPA can later treat the two types differently without losing data.
--  3. A posted distribution can be voided with a reason and re-posted: the old row stays (marked voided), the new one
--     points back at it, and the split it was made on is stored with it.

-- 1. The founder.
INSERT INTO public.user_roles (user_id, role)
SELECT user_id, 'founder'::public.app_role FROM public.user_roles WHERE role = 'admin'::public.app_role ORDER BY created_at ASC LIMIT 1
ON CONFLICT (user_id, role) DO NOTHING;

-- 2. Tagged contributions. (The confirm functions below replace the ones in expenses.sql: if expenses.sql is ever re-run, run this file again after it.)
CREATE TABLE IF NOT EXISTS public.owner_capital_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  holder_key text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  contribution_type text NOT NULL CHECK (contribution_type IN ('capital_call', 'expense')),
  source_allocation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_capital_contributions_owner_idx ON public.owner_capital_contributions (property_id, user_id, created_at DESC);
-- One contribution per confirmed payment, however many times a confirmation is retried.
CREATE UNIQUE INDEX IF NOT EXISTS owner_capital_contributions_one_per_payment ON public.owner_capital_contributions (contribution_type, source_allocation_id) WHERE source_allocation_id IS NOT NULL;

GRANT SELECT ON public.owner_capital_contributions TO authenticated;
GRANT ALL ON public.owner_capital_contributions TO service_role;
ALTER TABLE public.owner_capital_contributions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owners read own contributions" ON public.owner_capital_contributions;
CREATE POLICY "owners read own contributions" ON public.owner_capital_contributions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.is_property_owner(auth.uid(), property_id));

CREATE OR REPLACE FUNCTION public.credit_capital_contribution(_property uuid, _holder_key text, _amount numeric, _type text, _source uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  holder_user uuid;
BEGIN
  IF _type NOT IN ('capital_call', 'expense') THEN
    RAISE EXCEPTION 'A contribution is either a capital call or an expense' USING ERRCODE = 'check_violation';
  END IF;
  IF _holder_key LIKE 'seller:%' THEN
    holder_user := substr(_holder_key, 8)::uuid;
  ELSE
    SELECT auth_user_id INTO holder_user FROM public.buyer_accounts WHERE id = _holder_key::uuid;
  END IF;
  IF holder_user IS NULL THEN
    RAISE EXCEPTION 'This holder has no account to credit' USING ERRCODE = 'check_violation';
  END IF;
  -- The tagged record first: a retried confirmation hits the unique index and changes nothing.
  INSERT INTO public.owner_capital_contributions (property_id, user_id, holder_key, amount, contribution_type, source_allocation_id)
  VALUES (_property, holder_user, _holder_key, _amount, _type, _source)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO public.owner_capital_accounts (property_id, user_id, contributed_amount, updated_at)
  VALUES (_property, holder_user, _amount, now())
  ON CONFLICT (property_id, user_id)
  DO UPDATE SET contributed_amount = public.owner_capital_accounts.contributed_amount + EXCLUDED.contributed_amount, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_expense_payment(_allocation uuid, _actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a public.expense_allocations%ROWTYPE;
  property uuid;
BEGIN
  SELECT * INTO a FROM public.expense_allocations WHERE id = _allocation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Allocation not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF a.status = 'paid' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'already_confirmed');
  END IF;
  IF a.status <> 'due' OR a.paid_marked_at IS NULL THEN
    RAISE EXCEPTION 'The owner hasn''t marked this as paid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT property_id INTO property FROM public.expenses WHERE id = a.expense_id;
  UPDATE public.expense_allocations SET status = 'paid', confirmed_at = now(), confirmed_by = _actor WHERE id = a.id;
  PERFORM public.credit_capital_contribution(property, a.holder_key, a.amount, 'expense', a.id);
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, 'admin', 'expense.payment_confirmed', 'expense', a.expense_id::text, jsonb_build_object(
    'property_id', property, 'allocation_id', a.id, 'holder_key', a.holder_key, 'amount', a.amount));
  RETURN jsonb_build_object('applied', true, 'amount', a.amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_capital_call_payment(_allocation uuid, _actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a public.capital_call_allocations%ROWTYPE;
  property uuid;
BEGIN
  SELECT * INTO a FROM public.capital_call_allocations WHERE id = _allocation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Allocation not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF a.status = 'confirmed' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'already_confirmed');
  END IF;
  IF a.status <> 'marked_paid' THEN
    RAISE EXCEPTION 'The owner hasn''t marked this as paid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT property_id INTO property FROM public.capital_calls WHERE id = a.capital_call_id;
  UPDATE public.capital_call_allocations SET status = 'confirmed', confirmed_at = now(), confirmed_by = _actor WHERE id = a.id;
  PERFORM public.credit_capital_contribution(property, a.holder_key, a.amount, 'capital_call', a.id);
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, 'admin', 'capital_call.payment_confirmed', 'capital_call', a.capital_call_id::text, jsonb_build_object(
    'property_id', property, 'allocation_id', a.id, 'holder_key', a.holder_key, 'amount', a.amount));
  RETURN jsonb_build_object('applied', true, 'amount', a.amount);
END;
$$;

REVOKE ALL ON FUNCTION public.credit_capital_contribution(uuid, text, numeric, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_capital_contribution(uuid, text, numeric, text, uuid) TO service_role;

-- Backfill: payments confirmed before this file existed. The running total already includes them, so only the tagged
-- records are added (the unique index makes this safe to repeat).
INSERT INTO public.owner_capital_contributions (property_id, user_id, holder_key, amount, contribution_type, source_allocation_id, created_at)
SELECT e.property_id,
       CASE WHEN a.holder_key LIKE 'seller:%' THEN substr(a.holder_key, 8)::uuid ELSE (SELECT b.auth_user_id FROM public.buyer_accounts b WHERE b.id = a.holder_key::uuid) END,
       a.holder_key, a.amount, 'expense', a.id, COALESCE(a.confirmed_at, now())
FROM public.expense_allocations a JOIN public.expenses e ON e.id = a.expense_id
WHERE a.status = 'paid' AND a.amount > 0
ON CONFLICT DO NOTHING;
INSERT INTO public.owner_capital_contributions (property_id, user_id, holder_key, amount, contribution_type, source_allocation_id, created_at)
SELECT c.property_id,
       CASE WHEN a.holder_key LIKE 'seller:%' THEN substr(a.holder_key, 8)::uuid ELSE (SELECT b.auth_user_id FROM public.buyer_accounts b WHERE b.id = a.holder_key::uuid) END,
       a.holder_key, a.amount, 'capital_call', a.id, COALESCE(a.confirmed_at, now())
FROM public.capital_call_allocations a JOIN public.capital_calls c ON c.id = a.capital_call_id
WHERE a.status = 'confirmed' AND a.amount > 0
ON CONFLICT DO NOTHING;

-- 3. Distributions: void and re-post, with every version kept.
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'posted';
ALTER TABLE public.distribution_events DROP CONSTRAINT IF EXISTS distribution_events_status_check;
ALTER TABLE public.distribution_events ADD CONSTRAINT distribution_events_status_check CHECK (status IN ('posted', 'voided'));
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS voided_by uuid;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS void_reason text;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS replaces_id uuid REFERENCES public.distribution_events(id);
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS replaced_by_id uuid REFERENCES public.distribution_events(id);
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS lines jsonb;
COMMENT ON COLUMN public.distribution_events.lines IS
  'The split this notice was made on: [{"holder_key", "share_count", "amount"}], from the holders on the record date.';

-- A voided notice is never deleted or edited back: once voided it stays voided, with who and why.
CREATE OR REPLACE FUNCTION public.distribution_events_keep_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Distributions are never deleted. Void them instead.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'voided' AND (NEW.status <> 'voided' OR NEW.void_reason IS DISTINCT FROM OLD.void_reason OR NEW.total_amount <> OLD.total_amount OR NEW.record_date <> OLD.record_date) THEN
    RAISE EXCEPTION 'A voided distribution stays as it was.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'voided' AND (NEW.void_reason IS NULL OR btrim(NEW.void_reason) = '') THEN
    RAISE EXCEPTION 'A voided distribution needs a reason.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'posted' AND (NEW.total_amount <> OLD.total_amount OR NEW.record_date <> OLD.record_date OR NEW.property_id <> OLD.property_id) THEN
    RAISE EXCEPTION 'A posted distribution can''t be edited. Void it and post a corrected one.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS distribution_events_history ON public.distribution_events;
CREATE TRIGGER distribution_events_history BEFORE UPDATE OR DELETE ON public.distribution_events
  FOR EACH ROW EXECUTE FUNCTION public.distribution_events_keep_history();
