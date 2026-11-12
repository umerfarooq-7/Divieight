-- Month 6, Prompt 8: connect expenses to the books and allocate them to capital accounts.
-- Run in the Supabase SQL editor AFTER expenses.sql, bookkeeping.sql, capital-accounts.sql, bank-feed.sql, books.sql and
-- capital-events.sql. Safe to run again.
--
--   1. Posting a Month 5 expense now writes TWO journal entries through post_entry, in cents:
--        expense:<id>             Dr the expense account, Cr Cash       (the LLC bears the cost)
--        allocation-expense:<id>  Dr each member's capital account, Cr the expense account   (the cost passes to the members)
--      and the allocation lines must add up to the expense exactly (the Month 5 deferred check, plus a second check here).
--   2. Default allocation: pro rata to share count when the expense is posted (a two-member account counts as its share
--      count). Each line is rounded DOWN to the cent and the cents left over go to the holder with rank 1 (the Month 5 rule,
--      documented in src/lib/expenses.ts and in the admin tooltip). The database checks every line is where that rule puts it.
--   3. Operating Agreement override: allocation_overrides. If one applies, the allocation follows it; if none is configured, the
--      default applies. Manager-entered, audit logged, needs the OA section. Method 'custom_percent' (percentages that sum to
--      100%) is built; 'usage_adjusted' is the same manual-percent entry until the OA defines a formula.
--   4. A maintenance request attributed to the LLC becomes an expense, and posts through this same path.
--   5. Voiding an expense reverses both entries (the capital lines follow); the history stays.

-- ---------------------------------------------------------------------------------------------------------
-- 3. Overrides
-- ---------------------------------------------------------------------------------------------------------
-- Percentages by holder key ('<buyer account id>' or 'seller:<id>'), each above zero with at most two decimals, adding up to exactly 100.
CREATE OR REPLACE FUNCTION public.override_percents_ok(_params jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_typeof(_params -> 'percents') = 'object'
     AND (SELECT count(*) FROM jsonb_each_text(_params -> 'percents')) >= 1
     AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(_params -> 'percents') e WHERE e.value !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' OR (CASE WHEN e.value ~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' THEN e.value::numeric ELSE -1 END) <= 0)
     AND (SELECT sum(round(e.value::numeric * 100)) FROM jsonb_each_text(_params -> 'percents') e) = 10000;
$$;

CREATE TABLE IF NOT EXISTS public.allocation_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  -- Either every expense in a category, or one expense. Never both.
  expense_category text,
  expense_id uuid REFERENCES public.expenses(id),
  method text NOT NULL CHECK (method IN ('usage_adjusted', 'custom_percent')),
  parameters jsonb NOT NULL,
  source_oa_section text NOT NULL CHECK (btrim(source_oa_section) <> ''),
  approved_by uuid NOT NULL,
  effective_from date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retired_by uuid,
  retire_reason text,
  CHECK ((expense_category IS NOT NULL AND btrim(expense_category) <> '') <> (expense_id IS NOT NULL)),
  CHECK (public.override_percents_ok(parameters)),
  CHECK (method <> 'usage_adjusted' OR btrim(COALESCE(parameters ->> 'basis', '')) <> ''),
  CHECK ((retired_at IS NULL) = (retired_by IS NULL))
);
CREATE INDEX IF NOT EXISTS allocation_overrides_property_idx ON public.allocation_overrides (property_id, effective_from);

-- An override is never edited or deleted. It can be retired, once, and the retirement stays on the record.
CREATE OR REPLACE FUNCTION public.allocation_overrides_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'An allocation override is never deleted: retire it.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.retired_at IS NOT NULL
     OR NEW.property_id <> OLD.property_id OR NEW.expense_category IS DISTINCT FROM OLD.expense_category OR NEW.expense_id IS DISTINCT FROM OLD.expense_id
     OR NEW.method <> OLD.method OR NEW.parameters <> OLD.parameters OR NEW.source_oa_section <> OLD.source_oa_section
     OR NEW.approved_by <> OLD.approved_by OR NEW.effective_from <> OLD.effective_from OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'An allocation override can''t be edited. Retire it and enter a new one.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS allocation_overrides_guard_trg ON public.allocation_overrides;
CREATE TRIGGER allocation_overrides_guard_trg BEFORE UPDATE OR DELETE ON public.allocation_overrides FOR EACH ROW EXECUTE FUNCTION public.allocation_overrides_guard();
DROP TRIGGER IF EXISTS allocation_overrides_truncate_guard ON public.allocation_overrides;
CREATE TRIGGER allocation_overrides_truncate_guard BEFORE TRUNCATE ON public.allocation_overrides FOR EACH STATEMENT EXECUTE FUNCTION public.allocation_overrides_guard();

ALTER TABLE public.allocation_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.allocation_overrides FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.allocation_overrides TO authenticated, service_role;
DROP POLICY IF EXISTS "the Manager reads allocation overrides" ON public.allocation_overrides;
CREATE POLICY "the Manager reads allocation overrides" ON public.allocation_overrides FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- The expense that was allocated under an override, for the record.
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS allocation_override_id uuid REFERENCES public.allocation_overrides(id);

-- The override in force for an expense on a date: one named for that expense beats one for its category; the latest effective date wins.
CREATE OR REPLACE FUNCTION public.active_allocation_override(_property uuid, _category text, _expense uuid, _date date)
RETURNS public.allocation_overrides
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT o.* FROM public.allocation_overrides o
   WHERE o.property_id = _property AND o.retired_at IS NULL AND o.effective_from <= _date
     AND (o.expense_id = _expense OR (o.expense_id IS NULL AND o.expense_category = _category))
   ORDER BY (o.expense_id IS NOT NULL) DESC, o.effective_from DESC, o.created_at DESC
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.save_allocation_override(
  _property uuid, _category text, _expense uuid, _method text, _params jsonb, _oa_section text, _effective_from date, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  section text := NULLIF(btrim(COALESCE(_oa_section, '')), '');
  cat text := NULLIF(btrim(COALESCE(_category, '')), '');
  holders text[];
  keys text[];
  e public.expenses%ROWTYPE;
  new_id uuid;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can enter an allocation override.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF section IS NULL THEN
    RAISE EXCEPTION 'Name the Operating Agreement section this override comes from.' USING ERRCODE = 'check_violation';
  END IF;
  IF (cat IS NULL) = (_expense IS NULL) THEN
    RAISE EXCEPTION 'Choose either an expense category or one expense.' USING ERRCODE = 'check_violation';
  END IF;
  IF _method NOT IN ('usage_adjusted', 'custom_percent') THEN
    RAISE EXCEPTION 'Choose custom percentages or usage-adjusted (entered as percentages).' USING ERRCODE = 'check_violation';
  END IF;
  IF _effective_from IS NULL THEN
    RAISE EXCEPTION 'Say when the override takes effect.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.override_percents_ok(_params) THEN
    RAISE EXCEPTION 'The percentages must each be above zero and add up to exactly 100.' USING ERRCODE = 'check_violation';
  END IF;
  IF _method = 'usage_adjusted' AND btrim(COALESCE(_params ->> 'basis', '')) = '' THEN
    RAISE EXCEPTION 'Say what the usage adjustment is based on. The platform has no usage formula: you enter the percentages.' USING ERRCODE = 'check_violation';
  END IF;
  IF _expense IS NOT NULL THEN
    SELECT * INTO e FROM public.expenses WHERE id = _expense;
    IF NOT FOUND OR e.property_id <> _property THEN
      RAISE EXCEPTION 'That expense isn''t on this property.' USING ERRCODE = 'no_data_found';
    END IF;
    IF e.status <> 'draft' THEN
      RAISE EXCEPTION 'That expense is already %: its allocation is fixed.', e.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- It has to cover every holder on the cap table now, once each.
  SELECT array_agg(DISTINCT CASE WHEN holder_type = 'retained_seller' THEN 'seller:' || seller_id::text ELSE buyer_account_id::text END)
    INTO holders FROM public.cap_table_entries WHERE property_id = _property;
  SELECT array_agg(k) INTO keys FROM jsonb_object_keys(_params -> 'percents') k;
  IF holders IS NULL OR NOT (holders @> keys AND keys @> holders) THEN
    RAISE EXCEPTION 'The percentages must name every current holder of this home, once each.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.allocation_overrides (property_id, expense_category, expense_id, method, parameters, source_oa_section, approved_by, effective_from)
  VALUES (_property, cat, _expense, _method, _params, section, _actor, _effective_from) RETURNING id INTO new_id;
  PERFORM public.ledger_audit(_actor, 'allocation.override_saved', new_id, jsonb_build_object('property_id', _property, 'expense_category', cat, 'expense_id', _expense,
    'method', _method, 'parameters', _params, 'source_oa_section', section, 'effective_from', _effective_from, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.retire_allocation_override(_id uuid, _reason text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.allocation_overrides%ROWTYPE;
  why text := NULLIF(btrim(COALESCE(_reason, '')), '');
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can retire an allocation override.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF why IS NULL THEN
    RAISE EXCEPTION 'Say why this override is being retired.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO o FROM public.allocation_overrides WHERE id = _id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Allocation override not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF o.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'That override is already retired.' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.allocation_overrides SET retired_at = now(), retired_by = _actor, retire_reason = why WHERE id = _id;
  PERFORM public.ledger_audit(_actor, 'allocation.override_retired', _id, jsonb_build_object('property_id', o.property_id, 'reason', why, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 2 and 3. At posting, the allocation must be what the rules say: the override if one applies, the default if none is configured.
--          Each line may differ from its exact share by the rounding only: down to the cent, plus at most 7 leftover cents on rank 1.
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expense_allocation_follows_rules()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  ov public.allocation_overrides%ROWTYPE;
  total_cents bigint := round(NEW.total_amount * 100);
  issued integer;
  a record;
  exact numeric;
  cents bigint;
  pct text;
  rows_n integer;
BEGIN
  IF NEW.status <> 'posted' OR OLD.status = 'posted' THEN
    RETURN NEW;
  END IF;
  SELECT count(*), COALESCE(sum(share_count), 0) INTO rows_n, issued FROM public.expense_allocations WHERE expense_id = NEW.id;
  IF rows_n = 0 THEN
    RETURN NEW;
  END IF;
  ov := public.active_allocation_override(NEW.property_id, NEW.category, NEW.id, NEW.incurred_on);
  IF ov.id IS NOT NULL AND (SELECT count(*) FROM jsonb_object_keys(ov.parameters -> 'percents')) <> rows_n THEN
    RAISE EXCEPTION 'The Operating Agreement override for this expense doesn''t cover every holder on the cap table now. Retire it or enter a new one.' USING ERRCODE = 'check_violation';
  END IF;
  FOR a IN SELECT holder_key, share_count, amount FROM public.expense_allocations WHERE expense_id = NEW.id LOOP
    cents := round(a.amount * 100);
    IF ov.id IS NULL THEN
      exact := total_cents::numeric * a.share_count / issued;
    ELSE
      pct := ov.parameters -> 'percents' ->> a.holder_key;
      IF pct IS NULL THEN
        RAISE EXCEPTION 'The Operating Agreement override for this expense doesn''t name holder %.', a.holder_key USING ERRCODE = 'check_violation';
      END IF;
      exact := total_cents::numeric * pct::numeric / 100;
    END IF;
    IF cents < floor(exact) OR cents > floor(exact) + 7 THEN
      RAISE EXCEPTION 'This allocation doesn''t follow the % for this expense: % cents to % where about % cents is due.',
        CASE WHEN ov.id IS NULL THEN 'default pro-rata split' ELSE 'Operating Agreement override (' || ov.source_oa_section || ')' END, cents, a.holder_key, round(exact) USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  NEW.allocation_override_id := ov.id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS expenses_allocation_follows_rules ON public.expenses;
CREATE TRIGGER expenses_allocation_follows_rules BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.expense_allocation_follows_rules();

-- ---------------------------------------------------------------------------------------------------------
-- 1. The expense and its allocation, both through post_entry
-- ---------------------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_expense_entry ON public.journal_entries (property_id, source_ref)
  WHERE reverses_entry_id IS NULL AND source_ref ~ '^expense:';

CREATE OR REPLACE FUNCTION public.post_expense_allocation(_expense uuid, _actor uuid DEFAULT NULL, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.expenses%ROWTYPE;
  expense_ref text := 'expense:' || _expense::text;
  alloc_ref text := 'allocation-expense:' || _expense::text;
  expense_cents bigint;
  a record;
  lines jsonb := '[]'::jsonb;
  total bigint := 0;
  cents bigint;
  code text;
  expense_entry uuid;
  alloc_entry uuid;
  new_any boolean := false;
BEGIN
  SELECT * INTO e FROM public.expenses WHERE id = _expense;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.ledger_is_open(e.property_id) THEN
    RETURN jsonb_build_object('status', 'not_open');
  END IF;
  IF e.status <> 'posted' THEN
    RETURN jsonb_build_object('status', 'not_posted');
  END IF;
  expense_cents := round(e.total_amount * 100)::bigint;
  code := public.expense_account_code(e.category);

  -- The allocation has to add up to the expense exactly, in cents, before anything is written.
  FOR a IN SELECT holder_key, amount FROM public.expense_allocations WHERE expense_id = _expense ORDER BY holder_key LOOP
    cents := round(a.amount * 100)::bigint;
    IF cents > 0 THEN
      lines := lines || jsonb_build_array(jsonb_build_object('code', '3200', 'member_id', public.member_id_from_holder_key(a.holder_key), 'debit_cents', cents));
      total := total + cents;
    END IF;
  END LOOP;
  IF total = 0 THEN
    RETURN jsonb_build_object('status', 'no_allocations');
  END IF;
  IF total <> expense_cents THEN
    RAISE EXCEPTION 'The allocations add up to % cents but the expense is % cents.', total, expense_cents USING ERRCODE = 'check_violation';
  END IF;

  -- (1) The LLC bears the cost: Dr the expense account, Cr Cash.
  SELECT id INTO expense_entry FROM public.journal_entries WHERE property_id = e.property_id AND source_ref = expense_ref AND reverses_entry_id IS NULL;
  IF expense_entry IS NULL THEN
    expense_entry := public.post_entry(e.property_id,
      jsonb_build_array(jsonb_build_object('code', code, 'debit_cents', expense_cents), jsonb_build_object('code', '1000', 'credit_cents', expense_cents)),
      jsonb_build_object('source', 'expense', 'source_ref', expense_ref, 'entry_date', e.incurred_on, 'memo', 'Expense: ' || e.description,
        'created_by', _actor, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
    PERFORM public.ledger_audit(_actor, 'expense.posted_to_books', expense_entry, jsonb_build_object('property_id', e.property_id, 'expense_id', _expense, 'total_cents', expense_cents, 'account', code, 'override_id', e.allocation_override_id));
    new_any := true;
  END IF;

  -- (2) The cost passes to the members: Dr each member's capital account, Cr the expense account.
  SELECT id INTO alloc_entry FROM public.journal_entries WHERE property_id = e.property_id AND source_ref = alloc_ref AND reverses_entry_id IS NULL;
  IF alloc_entry IS NULL THEN
    lines := lines || jsonb_build_array(jsonb_build_object('code', code, 'credit_cents', total));
    alloc_entry := public.post_entry(e.property_id, lines, jsonb_build_object('source', 'expense', 'source_ref', alloc_ref, 'entry_date', e.incurred_on,
      'memo', 'Expense allocated to members: ' || e.description, 'created_by', _actor, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
    PERFORM public.ledger_audit(_actor, 'capital.expense_allocated', alloc_entry, jsonb_build_object('property_id', e.property_id, 'expense_id', _expense, 'total_cents', total,
      'members', jsonb_array_length(lines) - 1, 'override_id', e.allocation_override_id));
    new_any := true;
  END IF;
  IF NOT new_any THEN
    RETURN jsonb_build_object('status', 'already_posted');
  END IF;
  RETURN jsonb_build_object('status', 'posted', 'expense_entry_id', expense_entry, 'entry_id', alloc_entry, 'total_cents', total);
END;
$$;

-- Posting follows the expense; voiding reverses BOTH entries (the capital lines come back with them). Nothing is deleted.
CREATE OR REPLACE FUNCTION public.expense_status_to_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ref text;
  entry uuid;
  why text := 'The expense was voided' || COALESCE(': ' || NULLIF(btrim(NEW.void_reason), ''), '');
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF NEW.status = 'posted' THEN
      PERFORM public.post_expense_allocation(NEW.id, NEW.posted_by);
    ELSIF NEW.status = 'voided' AND public.ledger_is_open(NEW.property_id) THEN
      FOREACH ref IN ARRAY ARRAY['allocation-expense:' || NEW.id::text, 'expense:' || NEW.id::text] LOOP
        SELECT id INTO entry FROM public.journal_entries WHERE property_id = NEW.property_id AND source_ref = ref AND reverses_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.journal_entries r WHERE r.reverses_entry_id = journal_entries.id);
        IF entry IS NOT NULL THEN
          PERFORM public.reverse_entry(entry, why, jsonb_build_object('created_by', NEW.voided_by));
        END IF;
      END LOOP;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Ledger could not follow expense % (%): use sync_month5_events from the Books screens.', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.override_percents_ok(jsonb), public.active_allocation_override(uuid, text, uuid, date), public.expense_allocation_follows_rules(),
  public.allocation_overrides_guard(),
  public.save_allocation_override(uuid, text, uuid, text, jsonb, text, date, uuid, jsonb), public.retire_allocation_override(uuid, text, uuid, jsonb),
  public.post_expense_allocation(uuid, uuid, jsonb), public.expense_status_to_ledger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.active_allocation_override(uuid, text, uuid, date),
  public.save_allocation_override(uuid, text, uuid, text, jsonb, text, date, uuid, jsonb), public.retire_allocation_override(uuid, text, uuid, jsonb),
  public.post_expense_allocation(uuid, uuid, jsonb) TO service_role;
