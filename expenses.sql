-- Expense Management and capital calls. Run once in the Supabase SQL editor, AFTER
-- owner-dashboard.sql, votes.sql and maintenance.sql. Safe to re-run.
-- Only adds tables and functions, plus a foreign key on maintenance_requests.expense_id.
-- No money moves here: payment is only "marked paid" by an owner and confirmed by an admin.

CREATE TABLE IF NOT EXISTS public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  description text NOT NULL,
  category text NOT NULL,
  total_amount numeric(12, 2) NOT NULL CHECK (total_amount > 0),
  incurred_on date NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'maintenance')),
  maintenance_request_id uuid REFERENCES public.maintenance_requests(id) ON DELETE SET NULL,
  created_by uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'voided')),
  posted_at timestamptz,
  posted_by uuid,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source = 'maintenance' OR maintenance_request_id IS NULL)
);
CREATE INDEX IF NOT EXISTS expenses_property_idx ON public.expenses (property_id, incurred_on DESC);
-- A maintenance request becomes one expense, once.
CREATE UNIQUE INDEX IF NOT EXISTS expenses_one_per_maintenance_request
  ON public.expenses (maintenance_request_id) WHERE maintenance_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.expense_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  holder_key text NOT NULL,
  share_count integer NOT NULL CHECK (share_count > 0),
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid', 'waived')),
  -- 'due' with this set means the owner has marked it paid and an admin hasn't confirmed yet.
  paid_marked_at timestamptz,
  paid_marked_by uuid,
  confirmed_at timestamptz,
  confirmed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (expense_id, holder_key)
);
CREATE INDEX IF NOT EXISTS expense_allocations_holder_idx ON public.expense_allocations (holder_key);

CREATE TABLE IF NOT EXISTS public.capital_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  title text NOT NULL,
  reason text NOT NULL,
  total_amount numeric(12, 2) NOT NULL CHECK (total_amount > 0),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'closed')),
  vote_id uuid REFERENCES public.votes(id) ON DELETE SET NULL,
  created_by uuid,
  issued_at timestamptz,
  issued_by uuid,
  closed_at timestamptz,
  closed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS capital_calls_property_idx ON public.capital_calls (property_id, created_at DESC);
-- A vote approves one capital call.
CREATE UNIQUE INDEX IF NOT EXISTS capital_calls_one_per_vote ON public.capital_calls (vote_id) WHERE vote_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.capital_call_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capital_call_id uuid NOT NULL REFERENCES public.capital_calls(id) ON DELETE CASCADE,
  holder_key text NOT NULL,
  share_count integer NOT NULL CHECK (share_count > 0),
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'marked_paid', 'confirmed', 'overdue')),
  paid_marked_at timestamptz,
  paid_marked_by uuid,
  confirmed_at timestamptz,
  confirmed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capital_call_id, holder_key)
);
CREATE INDEX IF NOT EXISTS capital_call_allocations_holder_idx ON public.capital_call_allocations (holder_key);

-- The expense this request became.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_requests_expense_id_fkey') THEN
    ALTER TABLE public.maintenance_requests
      ADD CONSTRAINT maintenance_requests_expense_id_fkey
      FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The sum check: allocations always add up to the total, whoever writes them.
-- It runs when the transaction commits, so nothing can leave a split that doesn't add up.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_allocation_sum(_kind text, _parent uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  parent_status text;
  parent_total numeric;
  allocated numeric;
  row_count integer;
BEGIN
  IF _kind = 'expense' THEN
    SELECT status, total_amount INTO parent_status, parent_total FROM public.expenses WHERE id = _parent;
    SELECT COALESCE(SUM(amount), 0), count(*) INTO allocated, row_count FROM public.expense_allocations WHERE expense_id = _parent;
  ELSE
    SELECT status, total_amount INTO parent_status, parent_total FROM public.capital_calls WHERE id = _parent;
    SELECT COALESCE(SUM(amount), 0), count(*) INTO allocated, row_count FROM public.capital_call_allocations WHERE capital_call_id = _parent;
  END IF;
  IF parent_status IS NULL THEN RETURN; END IF; -- the parent is being deleted
  IF parent_status = 'draft' AND row_count = 0 THEN RETURN; END IF;
  -- A draft that was voided or closed before posting never had a split.
  IF parent_status IN ('voided', 'closed') AND row_count = 0 THEN RETURN; END IF;
  IF parent_status = 'draft' OR allocated <> parent_total THEN
    RAISE EXCEPTION 'Allocations must add up to the total exactly (% allocated of %, status %)', allocated, parent_total, parent_status
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_expense_allocation_sum()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    PERFORM public.assert_allocation_sum('expense', NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.assert_allocation_sum('expense', OLD.expense_id);
  ELSE
    PERFORM public.assert_allocation_sum('expense', NEW.expense_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_capital_call_allocation_sum()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_TABLE_NAME = 'capital_calls' THEN
    PERFORM public.assert_allocation_sum('capital_call', NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.assert_allocation_sum('capital_call', OLD.capital_call_id);
  ELSE
    PERFORM public.assert_allocation_sum('capital_call', NEW.capital_call_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS expenses_sum_check ON public.expenses;
CREATE CONSTRAINT TRIGGER expenses_sum_check AFTER INSERT OR UPDATE ON public.expenses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_expense_allocation_sum();
DROP TRIGGER IF EXISTS expense_allocations_sum_check ON public.expense_allocations;
CREATE CONSTRAINT TRIGGER expense_allocations_sum_check AFTER INSERT OR UPDATE OR DELETE ON public.expense_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_expense_allocation_sum();
DROP TRIGGER IF EXISTS capital_calls_sum_check ON public.capital_calls;
CREATE CONSTRAINT TRIGGER capital_calls_sum_check AFTER INSERT OR UPDATE ON public.capital_calls
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_capital_call_allocation_sum();
DROP TRIGGER IF EXISTS capital_call_allocations_sum_check ON public.capital_call_allocations;
CREATE CONSTRAINT TRIGGER capital_call_allocations_sum_check AFTER INSERT OR UPDATE OR DELETE ON public.capital_call_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_capital_call_allocation_sum();

-- A split is fixed once it exists: only its payment status moves.
CREATE OR REPLACE FUNCTION public.freeze_allocation_split()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.share_count <> OLD.share_count OR NEW.holder_key <> OLD.holder_key THEN
    RAISE EXCEPTION 'An allocation''s amount, shares and holder can''t change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS expense_allocations_frozen ON public.expense_allocations;
CREATE TRIGGER expense_allocations_frozen BEFORE UPDATE ON public.expense_allocations
  FOR EACH ROW EXECUTE FUNCTION public.freeze_allocation_split();
DROP TRIGGER IF EXISTS capital_call_allocations_frozen ON public.capital_call_allocations;
CREATE TRIGGER capital_call_allocations_frozen BEFORE UPDATE ON public.capital_call_allocations
  FOR EACH ROW EXECUTE FUNCTION public.freeze_allocation_split();

-- A total is fixed once posted, issued or put to a vote: the owners voted on that amount.
CREATE OR REPLACE FUNCTION public.freeze_expense_total()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.total_amount <> OLD.total_amount OR NEW.property_id <> OLD.property_id) THEN
    RAISE EXCEPTION 'A posted expense''s total can''t change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS expenses_total_frozen ON public.expenses;
CREATE TRIGGER expenses_total_frozen BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.freeze_expense_total();

CREATE OR REPLACE FUNCTION public.freeze_capital_call_total()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (OLD.status <> 'draft' OR OLD.vote_id IS NOT NULL) AND (NEW.total_amount <> OLD.total_amount OR NEW.property_id <> OLD.property_id) THEN
    RAISE EXCEPTION 'A capital call''s total can''t change once it is issued or put to a vote' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS capital_calls_total_frozen ON public.capital_calls;
CREATE TRIGGER capital_calls_total_frozen BEFORE UPDATE ON public.capital_calls
  FOR EACH ROW EXECUTE FUNCTION public.freeze_capital_call_total();

-- ---------------------------------------------------------------------------
-- Posting and issuing. The server works out the split (with the holders' ranks);
-- these check it against the cap table as it stands right now, and write it in
-- one transaction.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_allocations_match_cap_table(_property uuid, _total numeric, _allocations jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  allocated numeric;
  mismatches integer;
BEGIN
  IF _allocations IS NULL OR jsonb_typeof(_allocations) <> 'array' OR jsonb_array_length(_allocations) = 0 THEN
    RAISE EXCEPTION 'There are no issued shares to allocate to' USING ERRCODE = 'check_violation';
  END IF;

  SELECT SUM((a->>'amount')::numeric) INTO allocated FROM jsonb_array_elements(_allocations) a;
  IF allocated <> _total THEN
    RAISE EXCEPTION 'Allocations must add up to the total exactly (% allocated of %)', allocated, _total USING ERRCODE = 'check_violation';
  END IF;

  -- Hold the cap table still until this transaction ends.
  PERFORM 1 FROM public.cap_table_entries WHERE property_id = _property FOR SHARE;

  WITH cap AS (
    SELECT CASE WHEN holder_type = 'retained_seller' THEN 'seller:' || seller_id::text ELSE buyer_account_id::text END AS holder_key,
           count(*)::integer AS share_count
    FROM public.cap_table_entries WHERE property_id = _property GROUP BY 1
  ), given AS (
    SELECT a->>'holder_key' AS holder_key, (a->>'share_count')::integer AS share_count FROM jsonb_array_elements(_allocations) a
  )
  SELECT count(*) INTO mismatches FROM (
    (SELECT * FROM cap EXCEPT ALL SELECT * FROM given) UNION ALL (SELECT * FROM given EXCEPT ALL SELECT * FROM cap)
  ) d;
  IF mismatches > 0 THEN
    RAISE EXCEPTION 'The cap table just changed. Reload and try again.' USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.post_expense(_expense uuid, _allocations jsonb, _actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.expenses%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.expenses WHERE id = _expense FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF e.status = 'posted' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'already_posted');
  END IF;
  IF e.status <> 'draft' THEN
    RAISE EXCEPTION 'A voided expense can''t be posted' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public.assert_allocations_match_cap_table(e.property_id, e.total_amount, _allocations);

  INSERT INTO public.expense_allocations (expense_id, holder_key, share_count, amount)
  SELECT e.id, a->>'holder_key', (a->>'share_count')::integer, (a->>'amount')::numeric
  FROM jsonb_array_elements(_allocations) a;
  UPDATE public.expenses SET status = 'posted', posted_at = now(), posted_by = _actor WHERE id = e.id;

  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, 'admin', 'expense.posted', 'expense', e.id::text, jsonb_build_object(
    'property_id', e.property_id, 'total_amount', e.total_amount, 'allocations', _allocations));
  RETURN jsonb_build_object('applied', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.issue_capital_call(_call uuid, _allocations jsonb, _due_date date, _vote_required boolean, _actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.capital_calls%ROWTYPE;
  v public.votes%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.capital_calls WHERE id = _call FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Capital call not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF c.status = 'issued' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'already_issued');
  END IF;
  IF c.status <> 'draft' THEN
    RAISE EXCEPTION 'A closed capital call can''t be issued' USING ERRCODE = 'check_violation';
  END IF;
  IF _due_date IS NULL OR _due_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'The due date can''t be in the past' USING ERRCODE = 'check_violation';
  END IF;
  IF _vote_required THEN
    SELECT * INTO v FROM public.votes WHERE id = c.vote_id FOR SHARE;
    IF NOT FOUND OR v.property_id <> c.property_id OR v.status <> 'closed' OR COALESCE((v.result_summary->>'passed')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'This capital call needs a passed vote before it can be issued' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM public.assert_allocations_match_cap_table(c.property_id, c.total_amount, _allocations);

  INSERT INTO public.capital_call_allocations (capital_call_id, holder_key, share_count, amount)
  SELECT c.id, a->>'holder_key', (a->>'share_count')::integer, (a->>'amount')::numeric
  FROM jsonb_array_elements(_allocations) a;
  UPDATE public.capital_calls SET status = 'issued', due_date = _due_date, issued_at = now(), issued_by = _actor WHERE id = c.id;

  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, 'admin', 'capital_call.issued', 'capital_call', c.id::text, jsonb_build_object(
    'property_id', c.property_id, 'total_amount', c.total_amount, 'due_date', _due_date, 'vote_id', c.vote_id, 'vote_required', _vote_required, 'allocations', _allocations));
  RETURN jsonb_build_object('applied', true);
END;
$$;

-- Voiding keeps the record. Once someone has paid or said they paid, it can't be voided
-- here: their contribution would need unwinding, and that is a decision for a person.
CREATE OR REPLACE FUNCTION public.void_expense(_expense uuid, _reason text, _actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.expenses%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.expenses WHERE id = _expense FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF e.status = 'voided' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'already_voided');
  END IF;
  IF EXISTS (SELECT 1 FROM public.expense_allocations WHERE expense_id = e.id AND (status = 'paid' OR paid_marked_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'An owner has already paid or marked this expense paid, so it can''t be voided' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.expense_allocations SET status = 'waived' WHERE expense_id = e.id AND status = 'due';
  UPDATE public.expenses SET status = 'voided', voided_at = now(), voided_by = _actor, void_reason = _reason WHERE id = e.id;
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, 'admin', 'expense.voided', 'expense', e.id::text, jsonb_build_object('property_id', e.property_id, 'reason', _reason, 'was', e.status));
  RETURN jsonb_build_object('applied', true, 'was', e.status);
END;
$$;

-- ---------------------------------------------------------------------------
-- Confirming a payment. The status and the capital account change together, once.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.credit_capital_account(_property uuid, _holder_key text, _amount numeric)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  holder_user uuid;
BEGIN
  IF _holder_key LIKE 'seller:%' THEN
    holder_user := substr(_holder_key, 8)::uuid;
  ELSE
    SELECT auth_user_id INTO holder_user FROM public.buyer_accounts WHERE id = _holder_key::uuid;
  END IF;
  IF holder_user IS NULL THEN
    RAISE EXCEPTION 'This holder has no account to credit' USING ERRCODE = 'check_violation';
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
  PERFORM public.credit_capital_account(property, a.holder_key, a.amount);
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
  PERFORM public.credit_capital_account(property, a.holder_key, a.amount);
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, 'admin', 'capital_call.payment_confirmed', 'capital_call', a.capital_call_id::text, jsonb_build_object(
    'property_id', property, 'allocation_id', a.id, 'holder_key', a.holder_key, 'amount', a.amount));
  RETURN jsonb_build_object('applied', true, 'amount', a.amount);
END;
$$;

-- ---------------------------------------------------------------------------
-- "Attribute to LLC" on a maintenance request: a draft expense, linked both ways.
-- An admin still reviews and posts it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_expense_from_maintenance(_request uuid, _actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.maintenance_requests%ROWTYPE;
  new_id uuid;
  amount numeric;
BEGIN
  SELECT * INTO r FROM public.maintenance_requests WHERE id = _request FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.expense_id IS NOT NULL THEN
    RETURN jsonb_build_object('applied', false, 'expense_id', r.expense_id);
  END IF;
  amount := round(COALESCE(r.actual_cost, 0), 2);
  IF r.status <> 'completed' OR amount <= 0 THEN
    RAISE EXCEPTION 'Only a completed request with an actual cost above zero can be attributed' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.expenses (property_id, description, category, total_amount, incurred_on, source, maintenance_request_id, created_by)
  VALUES (
    r.property_id,
    'Maintenance: ' || r.title || COALESCE(' (' || r.vendor_name || ')', ''),
    r.category, amount, r.updated_at::date, 'maintenance', r.id, COALESCE(_actor, r.expense_queued_by)
  )
  RETURNING id INTO new_id;
  UPDATE public.maintenance_requests
  SET expense_id = new_id,
      expense_queued_at = COALESCE(expense_queued_at, now()),
      expense_queued_by = COALESCE(expense_queued_by, _actor),
      updated_at = now()
  WHERE id = r.id;
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, 'admin', 'expense.created_from_maintenance', 'expense', new_id::text, jsonb_build_object(
    'property_id', r.property_id, 'maintenance_request_id', r.id, 'total_amount', amount));
  RETURN jsonb_build_object('applied', true, 'expense_id', new_id);
END;
$$;

REVOKE ALL ON FUNCTION public.assert_allocation_sum(text, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_allocations_match_cap_table(uuid, numeric, jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.credit_capital_account(uuid, text, numeric) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_expense(uuid, jsonb, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.issue_capital_call(uuid, jsonb, date, boolean, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.void_expense(uuid, text, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_expense_payment(uuid, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_capital_call_payment(uuid, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_expense_from_maintenance(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_allocation_sum(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_allocations_match_cap_table(uuid, numeric, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.credit_capital_account(uuid, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_expense(uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.issue_capital_call(uuid, jsonb, date, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.void_expense(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_expense_payment(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_capital_call_payment(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_expense_from_maintenance(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Row-level security: read-only for signed-in users, every write through the server.
-- ---------------------------------------------------------------------------

-- Is this holder key the signed-in user? Only ever answers about the caller.
CREATE OR REPLACE FUNCTION public.is_my_holder_key(_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _key = 'seller:' || auth.uid()::text
      OR _key IN (SELECT b.id::text FROM public.buyer_accounts b WHERE b.auth_user_id = auth.uid());
$$;
REVOKE ALL ON FUNCTION public.is_my_holder_key(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_my_holder_key(text) TO authenticated, service_role;

GRANT SELECT ON public.expenses, public.expense_allocations, public.capital_calls, public.capital_call_allocations TO authenticated;
GRANT ALL ON public.expenses, public.expense_allocations, public.capital_calls, public.capital_call_allocations TO service_role;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capital_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capital_call_allocations ENABLE ROW LEVEL SECURITY;

-- An owner sees only their own allocation: never another holder's amount or payment status.
DROP POLICY IF EXISTS "holders read their own expense allocation" ON public.expense_allocations;
CREATE POLICY "holders read their own expense allocation" ON public.expense_allocations
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.is_my_holder_key(holder_key));

DROP POLICY IF EXISTS "holders read their own capital call allocation" ON public.capital_call_allocations;
CREATE POLICY "holders read their own capital call allocation" ON public.capital_call_allocations
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.is_my_holder_key(holder_key));

-- The property's expense list, without drafts. Someone who has since sold keeps sight
-- of what they were allocated.
DROP POLICY IF EXISTS "owners read their property's expenses" ON public.expenses;
CREATE POLICY "owners read their property's expenses" ON public.expenses
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (status <> 'draft' AND (
      public.is_property_owner(auth.uid(), property_id)
      OR EXISTS (SELECT 1 FROM public.expense_allocations a WHERE a.expense_id = id AND public.is_my_holder_key(a.holder_key))
    ))
  );

DROP POLICY IF EXISTS "owners read their property's capital calls" ON public.capital_calls;
CREATE POLICY "owners read their property's capital calls" ON public.capital_calls
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (status <> 'draft' AND (
      public.is_property_owner(auth.uid(), property_id)
      OR EXISTS (SELECT 1 FROM public.capital_call_allocations a WHERE a.capital_call_id = id AND public.is_my_holder_key(a.holder_key))
    ))
  );

-- Requests already queued from the Maintenance page become draft expenses now.
SELECT public.create_expense_from_maintenance(id, expense_queued_by)
FROM public.maintenance_requests
WHERE expense_queued_at IS NOT NULL AND expense_id IS NULL;
