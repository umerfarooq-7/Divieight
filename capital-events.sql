-- divieight — Month 6, Prompt 6: every event that affects a member's capital account is a journal entry, and the roll-forward.
--
-- Run in the Supabase SQL editor AFTER bookkeeping.sql, capital-accounts.sql and books.sql (and the Month 5 files:
-- expenses.sql, money-decisions.sql, resale-completion.sql). Safe to run again.
--
-- Every entry below is posted through post_entry with the member named on the line, so the capital_account_ledger
-- projection (capital-accounts.sql) updates on its own:
--   (a) contributions        a confirmed capital call or expense payment (owner_capital_contributions): Dr Cash, Cr Member Contributions
--   (b) allocable income     Other Income allocated to members, pro rata to shares by default: Dr Other Income, Cr Member Capital
--   (c) allocable expense    a posted expense (expense_allocations): Dr Member Capital, Cr the expense account
--   (d) depreciation         entered by the Manager from the CPA's schedule, never computed here: Dr Member Capital, Cr Accumulated Depreciation
--   (e) distributions        a posted distribution (distribution_events.lines): Dr Member Distributions, Cr Cash
--   (f) resale transfers     the selling holder's balance for the share moves to the acquiring member in one entry
--                            (transfer_out and transfer_in lines), tied to resale_transaction_id. No Section 754 adjustment is
--                            computed: a CPA Cooperation Worksheet flag is raised instead.
-- A Buyer Account is one capital account however many people are on it.
--
-- No double counting: the Month 5 'contributed' total (owner_capital_accounts) is a read model of the ledger. A tagged
-- contribution posts its own entry; the capture from capital-accounts.sql then finds the table and the ledger already agree.

-- ---------------------------------------------------------------------------------------------------------
-- 0. Small helpers
-- ---------------------------------------------------------------------------------------------------------
-- Month 5 names a holder 'seller:<uuid>' or by the Buyer Account's uuid; the ledger names the member by that uuid.
CREATE OR REPLACE FUNCTION public.member_id_from_holder_key(_holder_key text)
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN _holder_key LIKE 'seller:%' THEN substr(_holder_key, 8)::uuid ELSE _holder_key::uuid END;
$$;

-- Who held the shares at the end of a date, from today's cap table and cap_table_history (the rule record-date-holders uses).
CREATE OR REPLACE FUNCTION public.holder_shares_as_of(_property uuid, _date date)
RETURNS TABLE (member_id uuid, shares integer, first_share integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH cutoff AS (SELECT (((_date + 1)::timestamp) AT TIME ZONE 'UTC') AS t),
  later AS (
    SELECT DISTINCT ON (h.share_number) h.share_number, COALESCE(h.from_buyer_account_id, h.from_seller_id) AS member
    FROM public.cap_table_history h, cutoff WHERE h.property_id = _property AND h.changed_at >= cutoff.t
    ORDER BY h.share_number, h.changed_at ASC
  ),
  held AS (
    SELECT c.share_number, COALESCE(l.member, COALESCE(c.buyer_account_id, c.seller_id)) AS member
    FROM public.cap_table_entries c LEFT JOIN later l ON l.share_number = c.share_number WHERE c.property_id = _property
  )
  SELECT member, count(*)::integer, min(share_number)::integer FROM held WHERE member IS NOT NULL GROUP BY member ORDER BY min(share_number);
$$;

-- Split an amount pro rata to the shares held on a date, to the cent: leftover cents go one each to the lowest share numbers.
CREATE OR REPLACE FUNCTION public.allocate_cents(_property uuid, _date date, _total_cents bigint)
RETURNS TABLE (member_id uuid, shares integer, cents bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH h AS (SELECT * FROM public.holder_shares_as_of(_property, _date)),
  n AS (SELECT COALESCE(sum(shares), 0) AS n FROM h),
  base AS (SELECT h.member_id, h.shares, h.first_share, floor(_total_cents::numeric * h.shares / NULLIF(n.n, 0))::bigint AS c FROM h, n),
  rem AS (SELECT _total_cents - COALESCE(sum(c), 0) AS r FROM base)
  SELECT base.member_id, base.shares, base.c + CASE WHEN row_number() OVER (ORDER BY base.first_share) <= (SELECT r FROM rem) THEN 1 ELSE 0 END
  FROM base ORDER BY base.first_share;
$$;

-- The expense account a Month 5 expense category lands on (the Manager can capitalize it later with the Books screens).
CREATE OR REPLACE FUNCTION public.expense_account_code(_category text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE _category WHEN 'Insurance' THEN '6100' WHEN 'Property tax' THEN '6000' WHEN 'Utilities' THEN '6300' WHEN 'Management' THEN '6500' ELSE '6400' END;
$$;

-- Once per source: a contribution, an allocation, a depreciation entry, a distribution or a transfer is posted once, however often asked.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_capital_event ON public.journal_entries (property_id, source_ref)
  WHERE reverses_entry_id IS NULL AND source_ref ~ '^(contribution|allocation-expense|allocation-income|depreciation|distribution|resale):';

-- ---------------------------------------------------------------------------------------------------------
-- 1. The projection learns the kinds of allocation (by reference, so a reversal keeps its kind), and the Month 5 table
--    isn't re-synced for a contribution that is being posted from the tagged record.
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.project_capital_account_line()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  acct record;
  e record;
  amt bigint;
  prev bigint;
  lt text;
BEGIN
  SELECT code, is_member_control INTO acct FROM public.coa_accounts WHERE id = NEW.account_id;
  IF NOT acct.is_member_control OR NEW.member_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT property_id, entry_date, source, source_ref INTO e FROM public.journal_entries WHERE id = NEW.entry_id;
  amt := NEW.credit_cents - NEW.debit_cents;
  lt := CASE
    WHEN acct.code = '3100' THEN 'distribution'
    WHEN acct.code = '3000' AND e.source = 'opening' THEN 'opening'
    WHEN acct.code = '3000' THEN 'contribution'
    WHEN e.source = 'resale' THEN CASE WHEN amt > 0 THEN 'transfer_in' ELSE 'transfer_out' END
    WHEN COALESCE(e.source_ref, '') LIKE 'depreciation%' THEN 'depreciation'
    WHEN COALESCE(e.source_ref, '') LIKE 'allocation-expense:%' THEN 'expense'
    WHEN COALESCE(e.source_ref, '') LIKE 'allocation-income:%' THEN 'income'
    WHEN amt > 0 THEN 'income'
    ELSE 'expense'
  END;
  PERFORM pg_advisory_xact_lock(hashtext(e.property_id::text || NEW.member_id::text));
  SELECT balance_after_cents INTO prev FROM public.capital_account_ledger WHERE property_id = e.property_id AND member_key = NEW.member_id ORDER BY seq DESC LIMIT 1;
  PERFORM set_config('app.capital_projection', 'on', true);
  INSERT INTO public.capital_account_ledger (property_id, member_key, entry_id, line_id, line_type, amount_cents, balance_after_cents, effective_date)
  VALUES (e.property_id, NEW.member_id, NEW.entry_id, NEW.id, lt, amt, COALESCE(prev, 0) + amt, e.entry_date);
  PERFORM set_config('app.capital_projection', 'off', true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_owner_capital_from_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  holder uuid;
  t record;
  eff_c bigint := 0;
  eff_d bigint := 0;
  cur record;
  has_row boolean;
BEGIN
  IF NEW.line_type NOT IN ('contribution', 'distribution') THEN
    RETURN NULL;
  END IF;
  -- A contribution posted from its tagged record: Month 5 writes the table itself, once, right after.
  IF COALESCE(current_setting('app.skip_owner_sync', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  holder := NEW.member_key;
  IF EXISTS (SELECT 1 FROM public.buyer_accounts WHERE id = NEW.member_key) THEN
    SELECT auth_user_id INTO holder FROM public.buyer_accounts WHERE id = NEW.member_key;
  END IF;
  IF holder IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO t FROM public.capital_member_totals(NEW.property_id, NEW.member_key);
  IF NEW.line_type = 'contribution' THEN eff_c := NEW.amount_cents; ELSE eff_d := -NEW.amount_cents; END IF;
  SELECT round(contributed_amount * 100)::bigint AS c, round(distributions_amount * 100)::bigint AS d INTO cur
  FROM public.owner_capital_accounts WHERE property_id = NEW.property_id AND user_id = holder;
  has_row := FOUND;
  PERFORM set_config('app.ledger_sync', 'on', true);
  IF NOT has_row THEN
    INSERT INTO public.owner_capital_accounts (property_id, user_id, contributed_amount, distributions_amount, updated_at)
    VALUES (NEW.property_id, holder, t.contributed_cents / 100.0, t.distributions_cents / 100.0, now());
  ELSIF cur.c = t.contributed_cents - eff_c AND cur.d = t.distributions_cents - eff_d THEN
    UPDATE public.owner_capital_accounts SET contributed_amount = t.contributed_cents / 100.0, distributions_amount = t.distributions_cents / 100.0, updated_at = now()
    WHERE property_id = NEW.property_id AND user_id = holder;
  END IF;
  PERFORM set_config('app.ledger_sync', 'off', true);
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 2. (a) Contributions
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_contribution_entry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  member uuid;
  cents bigint := round(NEW.amount * 100)::bigint;
BEGIN
  IF NOT public.ledger_is_open(NEW.property_id) THEN
    RETURN NULL; -- before the books open, the opening migration brings the running total in
  END IF;
  BEGIN
    member := public.member_id_from_holder_key(NEW.holder_key);
    PERFORM set_config('app.skip_owner_sync', 'on', true);
    PERFORM public.post_entry(NEW.property_id,
      jsonb_build_array(jsonb_build_object('code', '1000', 'debit_cents', cents), jsonb_build_object('code', '3000', 'member_id', member, 'credit_cents', cents)),
      jsonb_build_object('source', NEW.contribution_type, 'source_ref', 'contribution:' || NEW.id::text, 'entry_date', NEW.created_at::date,
        'memo', CASE NEW.contribution_type WHEN 'capital_call' THEN 'Capital call payment confirmed' ELSE 'Expense payment confirmed' END));
    PERFORM set_config('app.skip_owner_sync', 'off', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.skip_owner_sync', 'off', true);
    -- Never blocks a payment confirmation. The capture in capital-accounts.sql posts the difference if the ledger is behind.
    RAISE WARNING 'Ledger could not take contribution % (%): the owner_capital_accounts capture will bring it in.', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. (c) Allocable expense
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_expense_allocation(_expense uuid, _actor uuid DEFAULT NULL, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.expenses%ROWTYPE;
  ref text := 'allocation-expense:' || _expense::text;
  a record;
  lines jsonb := '[]'::jsonb;
  total bigint := 0;
  cents bigint;
  entry uuid;
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
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE property_id = e.property_id AND source_ref = ref AND reverses_entry_id IS NULL) THEN
    RETURN jsonb_build_object('status', 'already_posted');
  END IF;
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
  lines := lines || jsonb_build_array(jsonb_build_object('code', public.expense_account_code(e.category), 'credit_cents', total));
  entry := public.post_entry(e.property_id, lines, jsonb_build_object('source', 'expense', 'source_ref', ref, 'entry_date', e.incurred_on,
    'memo', 'Expense allocated to members: ' || e.description, 'created_by', _actor, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  PERFORM public.ledger_audit(_actor, 'capital.expense_allocated', entry, jsonb_build_object('property_id', e.property_id, 'expense_id', _expense, 'total_cents', total, 'members', jsonb_array_length(lines) - 1));
  RETURN jsonb_build_object('status', 'posted', 'entry_id', entry, 'total_cents', total);
END;
$$;

CREATE OR REPLACE FUNCTION public.expense_status_to_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ref text := 'allocation-expense:' || NEW.id::text;
  entry uuid;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF NEW.status = 'posted' THEN
      PERFORM public.post_expense_allocation(NEW.id, NULL);
    ELSIF NEW.status = 'voided' AND public.ledger_is_open(NEW.property_id) THEN
      SELECT id INTO entry FROM public.journal_entries WHERE property_id = NEW.property_id AND source_ref = ref AND reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.journal_entries r WHERE r.reverses_entry_id = journal_entries.id);
      IF entry IS NOT NULL THEN
        PERFORM public.reverse_entry(entry, 'The expense was voided', jsonb_build_object('created_by', NULL));
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Ledger could not follow expense % (%): use sync_month5_events from the Books screens.', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. (b) Allocable income
-- ---------------------------------------------------------------------------------------------------------
-- Allocate the Other Income not yet allocated, as of a date, to the members who held shares then (pro rata to shares, the
-- default). Income closes into member capital: Dr Other Income, Cr Member Capital. Run again and there is nothing left.
CREATE OR REPLACE FUNCTION public.allocate_income(_property uuid, _as_of date, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bal bigint;
  seq integer;
  lines jsonb := '[]'::jsonb;
  a record;
  entry uuid;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can allocate income.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF _as_of IS NULL OR _as_of > current_date THEN
    RAISE EXCEPTION 'Choose a date that has passed.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.ledger_is_open(_property) THEN
    RAISE EXCEPTION 'The books for this LLC are not open yet.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(l.credit_cents - l.debit_cents), 0) INTO bal
  FROM public.journal_entries e JOIN public.journal_lines l ON l.entry_id = e.id JOIN public.coa_accounts c ON c.id = l.account_id
  WHERE e.property_id = _property AND e.entry_date <= _as_of AND c.code = '4000';
  IF bal <= 0 THEN
    RETURN jsonb_build_object('status', 'nothing_to_allocate');
  END IF;
  lines := jsonb_build_array(jsonb_build_object('code', '4000', 'debit_cents', bal));
  FOR a IN SELECT * FROM public.allocate_cents(_property, _as_of, bal) LOOP
    IF a.cents > 0 THEN
      lines := lines || jsonb_build_array(jsonb_build_object('code', '3200', 'member_id', a.member_id, 'credit_cents', a.cents));
    END IF;
  END LOOP;
  IF jsonb_array_length(lines) < 2 THEN
    RAISE EXCEPTION 'No one held shares on %.', _as_of USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) + 1 INTO seq FROM public.journal_entries WHERE property_id = _property AND source_ref LIKE 'allocation-income:' || _property::text || ':' || _as_of::text || ':%' AND reverses_entry_id IS NULL;
  entry := public.post_entry(_property, lines, jsonb_build_object('source', 'system', 'source_ref', 'allocation-income:' || _property::text || ':' || _as_of::text || ':' || seq, 'entry_date', _as_of,
    'memo', 'Income allocated to members pro rata to shares', 'created_by', _actor, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  PERFORM public.ledger_audit(_actor, 'capital.income_allocated', entry, jsonb_build_object('property_id', _property, 'as_of', _as_of, 'total_cents', bal, 'members', jsonb_array_length(lines) - 1, 'basis', 'pro rata to shares', 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('status', 'posted', 'entry_id', entry, 'total_cents', bal);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. (d) Depreciation: the Manager enters the CPA's figure. Nothing here computes depreciation.
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_depreciation(_property uuid, _year integer, _amount_cents bigint, _schedule_ref text, _note text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sched text := NULLIF(btrim(COALESCE(_schedule_ref, '')), '');
  as_of date;
  n integer;
  lines jsonb;
  a record;
  entry uuid;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can enter depreciation.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF _year IS NULL OR _year < 2000 OR _year > extract(year FROM current_date)::int THEN
    RAISE EXCEPTION 'Choose a tax year that has begun.' USING ERRCODE = 'check_violation';
  END IF;
  IF _amount_cents IS NULL OR _amount_cents <= 0 THEN
    RAISE EXCEPTION 'Enter the depreciation from the CPA''s schedule, as a whole number of cents above zero.' USING ERRCODE = 'check_violation';
  END IF;
  IF sched IS NULL THEN
    RAISE EXCEPTION 'Name the CPA''s schedule this figure comes from. The platform doesn''t calculate depreciation.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.ledger_is_open(_property) THEN
    RAISE EXCEPTION 'The books for this LLC are not open yet.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries e WHERE e.property_id = _property AND e.source_ref LIKE 'depreciation:' || _property::text || ':' || _year || ':%' AND e.reverses_entry_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM public.journal_entries r WHERE r.reverses_entry_id = e.id)) THEN
    RAISE EXCEPTION 'Depreciation for % is already entered. Reverse it first to enter a corrected figure.', _year USING ERRCODE = 'unique_violation';
  END IF;
  as_of := make_date(_year, 12, 31);
  lines := jsonb_build_array(jsonb_build_object('code', '1290', 'credit_cents', _amount_cents));
  FOR a IN SELECT * FROM public.allocate_cents(_property, as_of, _amount_cents) LOOP
    IF a.cents > 0 THEN
      lines := lines || jsonb_build_array(jsonb_build_object('code', '3200', 'member_id', a.member_id, 'debit_cents', a.cents));
    END IF;
  END LOOP;
  IF jsonb_array_length(lines) < 2 THEN
    RAISE EXCEPTION 'No one held shares on %.', as_of USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) + 1 INTO n FROM public.journal_entries WHERE property_id = _property AND source_ref LIKE 'depreciation:' || _property::text || ':' || _year || ':%' AND reverses_entry_id IS NULL;
  entry := public.post_entry(_property, lines, jsonb_build_object('source', 'system', 'source_ref', 'depreciation:' || _property::text || ':' || _year || ':' || n, 'entry_date', as_of,
    'memo', 'Depreciation for ' || _year || ' per the CPA''s schedule ' || sched || COALESCE(': ' || NULLIF(btrim(COALESCE(_note, '')), ''), ''), 'created_by', _actor,
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent',
    'is_adjustment', COALESCE((_meta->>'is_adjustment')::boolean, false), 'adjustment_reason', _meta->>'adjustment_reason'));
  PERFORM public.ledger_audit(_actor, 'capital.depreciation_entered', entry, jsonb_build_object('property_id', _property, 'year', _year, 'amount_cents', _amount_cents, 'schedule', sched,
    'source', 'entered by the Manager from the CPA''s schedule', 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('status', 'posted', 'entry_id', entry, 'amount_cents', _amount_cents);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 6. (e) Distributions
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_distribution_event(_event uuid, _actor uuid DEFAULT NULL, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.distribution_events%ROWTYPE;
  ref text := 'distribution:' || _event::text;
  l jsonb;
  lines jsonb := '[]'::jsonb;
  total bigint := 0;
  cents bigint;
  a record;
  entry uuid;
BEGIN
  SELECT * INTO d FROM public.distribution_events WHERE id = _event;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Distribution not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.ledger_is_open(d.property_id) THEN
    RETURN jsonb_build_object('status', 'not_open');
  END IF;
  IF d.status IS DISTINCT FROM 'posted' THEN
    RETURN jsonb_build_object('status', 'not_posted');
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE property_id = d.property_id AND source_ref = ref AND reverses_entry_id IS NULL) THEN
    RETURN jsonb_build_object('status', 'already_posted');
  END IF;
  IF d.lines IS NOT NULL AND jsonb_typeof(d.lines) = 'array' AND jsonb_array_length(d.lines) > 0 THEN
    FOR l IN SELECT * FROM jsonb_array_elements(d.lines) LOOP
      cents := round((l->>'amount')::numeric * 100)::bigint;
      IF cents > 0 THEN
        lines := lines || jsonb_build_array(jsonb_build_object('code', '3100', 'member_id', public.member_id_from_holder_key(l->>'holder_key'), 'debit_cents', cents));
        total := total + cents;
      END IF;
    END LOOP;
  ELSE
    FOR a IN SELECT * FROM public.allocate_cents(d.property_id, d.record_date, round(d.total_amount * 100)::bigint) LOOP
      IF a.cents > 0 THEN
        lines := lines || jsonb_build_array(jsonb_build_object('code', '3100', 'member_id', a.member_id, 'debit_cents', a.cents));
        total := total + a.cents;
      END IF;
    END LOOP;
  END IF;
  IF total = 0 THEN
    RETURN jsonb_build_object('status', 'no_allocations');
  END IF;
  lines := lines || jsonb_build_array(jsonb_build_object('code', '1000', 'credit_cents', total));
  entry := public.post_entry(d.property_id, lines, jsonb_build_object('source', 'distribution', 'source_ref', ref, 'entry_date', d.record_date,
    'memo', 'Distribution by record date ' || d.record_date, 'created_by', _actor, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  PERFORM public.ledger_audit(_actor, 'capital.distribution_posted', entry, jsonb_build_object('property_id', d.property_id, 'distribution_id', _event, 'total_cents', total, 'record_date', d.record_date));
  RETURN jsonb_build_object('status', 'posted', 'entry_id', entry, 'total_cents', total);
END;
$$;

CREATE OR REPLACE FUNCTION public.distribution_status_to_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ref text := 'distribution:' || NEW.id::text;
  entry uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NULL;
    END IF;
  END IF;
  BEGIN
    IF NEW.status = 'posted' THEN
      PERFORM public.post_distribution_event(NEW.id, NULL);
    ELSIF NEW.status = 'voided' AND public.ledger_is_open(NEW.property_id) THEN
      SELECT id INTO entry FROM public.journal_entries WHERE property_id = NEW.property_id AND source_ref = ref AND reverses_entry_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.journal_entries r WHERE r.reverses_entry_id = journal_entries.id);
      IF entry IS NOT NULL THEN
        PERFORM public.reverse_entry(entry, 'The distribution was voided', jsonb_build_object('created_by', NULL));
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Ledger could not follow distribution % (%): use sync_month5_events from the Books screens.', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 7. (f) Resale transfers
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.capital_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  resale_transaction_id uuid NOT NULL UNIQUE,
  entry_id uuid REFERENCES public.journal_entries(id),
  share_number integer NOT NULL,
  from_member uuid NOT NULL,
  to_member uuid NOT NULL,
  seller_shares_before integer NOT NULL,
  seller_balance_before_cents bigint NOT NULL,
  transferred_cents bigint NOT NULL,
  recorded_price numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS capital_transfers_guard ON public.capital_transfers;
CREATE TRIGGER capital_transfers_guard BEFORE UPDATE OR DELETE ON public.capital_transfers FOR EACH ROW EXECUTE FUNCTION public.period_events_guard();
ALTER TABLE public.capital_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.capital_transfers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.capital_transfers TO authenticated, service_role;
DROP POLICY IF EXISTS "the Manager reads capital transfers" ON public.capital_transfers;
CREATE POLICY "the Manager reads capital transfers" ON public.capital_transfers FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- The selling holder's capital attributable to the share (their balance over the shares they held just before) moves to the
-- acquiring member: one entry, a transfer_out line and a transfer_in line, so total capital is unchanged. The recorded
-- price is kept with it. No basis or Section 754 figure is computed: a CPA Cooperation Worksheet flag is raised.
CREATE OR REPLACE FUNCTION public.post_resale_transfer(_history uuid, _actor uuid DEFAULT NULL, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  h public.cap_table_history%ROWTYPE;
  r public.resale_transactions%ROWTYPE;
  from_m uuid;
  to_m uuid;
  ref text;
  shares_before integer;
  bal bigint;
  amt bigint;
  lines jsonb;
  entry uuid;
BEGIN
  SELECT * INTO h FROM public.cap_table_history WHERE id = _history;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transfer not found' USING ERRCODE = 'no_data_found';
  END IF;
  ref := 'resale:' || h.resale_transaction_id::text;
  SELECT * INTO r FROM public.resale_transactions WHERE id = h.resale_transaction_id;
  from_m := COALESCE(h.from_buyer_account_id, h.from_seller_id);
  to_m := COALESCE(h.to_buyer_account_id, h.to_seller_id);
  IF NOT public.ledger_is_open(h.property_id) THEN
    RETURN jsonb_build_object('status', 'not_open');
  END IF;
  IF EXISTS (SELECT 1 FROM public.capital_transfers WHERE resale_transaction_id = h.resale_transaction_id) THEN
    RETURN jsonb_build_object('status', 'already_posted');
  END IF;
  -- Even a transfer with nothing to move raises the CPA's flag.
  INSERT INTO public.cpa_worksheet_flags (property_id, resale_transaction_id, flag_type, note)
  SELECT h.property_id, h.resale_transaction_id, 'cpa_cooperation_worksheet',
         'Share #' || h.share_number || ' changed hands: capital account transfer recorded in the ledger for the CPA''s cooperation worksheet. No Section 754 basis adjustment is computed on this platform.'
  WHERE NOT EXISTS (SELECT 1 FROM public.cpa_worksheet_flags f WHERE f.resale_transaction_id = h.resale_transaction_id AND f.flag_type = 'cpa_cooperation_worksheet');
  IF from_m IS NULL OR to_m IS NULL OR from_m = to_m THEN
    RETURN jsonb_build_object('status', 'same_holder');
  END IF;
  -- The share has already moved on the cap table: the seller held one more share just before.
  SELECT count(*)::integer + 1 INTO shares_before FROM public.cap_table_entries WHERE property_id = h.property_id AND (buyer_account_id = from_m OR seller_id = from_m);
  SELECT balance_cents INTO bal FROM public.capital_member_totals(h.property_id, from_m);
  amt := round(bal::numeric / shares_before)::bigint;
  IF amt <> 0 THEN
    lines := CASE WHEN amt > 0
      THEN jsonb_build_array(jsonb_build_object('code', '3200', 'member_id', from_m, 'debit_cents', amt), jsonb_build_object('code', '3200', 'member_id', to_m, 'credit_cents', amt))
      ELSE jsonb_build_array(jsonb_build_object('code', '3200', 'member_id', to_m, 'debit_cents', -amt), jsonb_build_object('code', '3200', 'member_id', from_m, 'credit_cents', -amt)) END;
    entry := public.post_entry(h.property_id, lines, jsonb_build_object('source', 'resale', 'source_ref', ref, 'entry_date', h.changed_at::date,
      'memo', 'Capital transfer for share #' || h.share_number || COALESCE(' at the recorded price of ' || r.price, '') || '. No Section 754 adjustment computed.', 'created_by', _actor,
      'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  END IF;
  INSERT INTO public.capital_transfers (property_id, resale_transaction_id, entry_id, share_number, from_member, to_member, seller_shares_before, seller_balance_before_cents, transferred_cents, recorded_price)
  VALUES (h.property_id, h.resale_transaction_id, entry, h.share_number, from_m, to_m, shares_before, bal, amt, r.price);
  PERFORM public.ledger_audit(_actor, 'capital.resale_transfer', COALESCE(entry, h.resale_transaction_id), jsonb_build_object('property_id', h.property_id, 'resale_transaction_id', h.resale_transaction_id, 'share_number', h.share_number,
    'from_member', from_m, 'to_member', to_m, 'seller_balance_before_cents', bal, 'seller_shares_before', shares_before, 'transferred_cents', amt, 'section_754', 'not computed; CPA flag raised'));
  RETURN jsonb_build_object('status', 'posted', 'entry_id', entry, 'transferred_cents', amt);
END;
$$;

CREATE OR REPLACE FUNCTION public.resale_history_to_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.post_resale_transfer(NEW.id, NULL);
  EXCEPTION WHEN OTHERS THEN
    -- Never blocks a completed sale (an Ownership Function). The Manager can post it from the Books screens.
    RAISE WARNING 'Ledger could not record the capital transfer for sale % (%).', NEW.resale_transaction_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 8. Month 5 events the ledger hasn't seen (the books were not open yet, or a posting was refused): post them, once.
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_month5_events(_property uuid, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  x record;
  r jsonb;
  expenses_posted integer := 0;
  distributions_posted integer := 0;
  transfers_posted integer := 0;
  problems jsonb := '[]'::jsonb;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can post Month 5 events.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.ledger_is_open(_property) THEN
    RAISE EXCEPTION 'The books for this LLC are not open yet.' USING ERRCODE = 'check_violation';
  END IF;
  IF to_regclass('public.expenses') IS NOT NULL THEN
    FOR x IN SELECT id FROM public.expenses WHERE property_id = _property AND status = 'posted' ORDER BY incurred_on, id LOOP
      BEGIN
        r := public.post_expense_allocation(x.id, _actor, _meta);
        IF r->>'status' = 'posted' THEN expenses_posted := expenses_posted + 1; END IF;
      EXCEPTION WHEN OTHERS THEN
        problems := problems || jsonb_build_array(jsonb_build_object('expense_id', x.id, 'error', left(SQLERRM, 200)));
      END;
    END LOOP;
  END IF;
  IF to_regclass('public.distribution_events') IS NOT NULL THEN
    FOR x IN SELECT id FROM public.distribution_events WHERE property_id = _property AND status = 'posted' ORDER BY record_date, id LOOP
      BEGIN
        r := public.post_distribution_event(x.id, _actor, _meta);
        IF r->>'status' = 'posted' THEN distributions_posted := distributions_posted + 1; END IF;
      EXCEPTION WHEN OTHERS THEN
        problems := problems || jsonb_build_array(jsonb_build_object('distribution_id', x.id, 'error', left(SQLERRM, 200)));
      END;
    END LOOP;
  END IF;
  FOR x IN SELECT id FROM public.cap_table_history WHERE property_id = _property AND NOT EXISTS (SELECT 1 FROM public.capital_transfers t WHERE t.resale_transaction_id = cap_table_history.resale_transaction_id) ORDER BY changed_at LOOP
    BEGIN
      r := public.post_resale_transfer(x.id, _actor, _meta);
      IF r->>'status' = 'posted' THEN transfers_posted := transfers_posted + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      problems := problems || jsonb_build_array(jsonb_build_object('history_id', x.id, 'error', left(SQLERRM, 200)));
    END;
  END LOOP;
  PERFORM public.ledger_audit(_actor, 'capital.month5_synced', _property, jsonb_build_object('property_id', _property, 'expenses', expenses_posted, 'distributions', distributions_posted, 'transfers', transfers_posted, 'problems', problems));
  RETURN jsonb_build_object('expenses', expenses_posted, 'distributions', distributions_posted, 'transfers', transfers_posted, 'problems', problems);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 9. The roll-forward
-- ---------------------------------------------------------------------------------------------------------
-- Per member, for a year: beginning capital, what moved it (signed, as it affects capital) and ending capital. Beginning of
-- year N+1 is ending of year N by construction: both are the member's running total at a year boundary.
CREATE OR REPLACE FUNCTION public.capital_roll_forward(_property uuid, _year integer)
RETURNS TABLE (member_key uuid, beginning_cents bigint, opening_cents bigint, contributions_cents bigint, income_cents bigint, expense_cents bigint,
               depreciation_cents bigint, distributions_cents bigint, transfer_in_cents bigint, transfer_out_cents bigint, ending_cents bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH w AS (SELECT make_date(_year, 1, 1) AS y0, make_date(_year, 12, 31) AS y1)
  SELECT c.member_key,
    COALESCE(sum(c.amount_cents) FILTER (WHERE c.effective_date < w.y0), 0)::bigint,
    COALESCE(sum(c.amount_cents) FILTER (WHERE c.effective_date BETWEEN w.y0 AND w.y1 AND c.line_type = 'opening'), 0)::bigint,
    COALESCE(sum(c.amount_cents) FILTER (WHERE c.effective_date BETWEEN w.y0 AND w.y1 AND c.line_type = 'contribution'), 0)::bigint,
    COALESCE(sum(c.amount_cents) FILTER (WHERE c.effective_date BETWEEN w.y0 AND w.y1 AND c.line_type = 'income'), 0)::bigint,
    COALESCE(sum(c.amount_cents) FILTER (WHERE c.effective_date BETWEEN w.y0 AND w.y1 AND c.line_type = 'expense'), 0)::bigint,
    COALESCE(sum(c.amount_cents) FILTER (WHERE c.effective_date BETWEEN w.y0 AND w.y1 AND c.line_type = 'depreciation'), 0)::bigint,
    COALESCE(sum(c.amount_cents) FILTER (WHERE c.effective_date BETWEEN w.y0 AND w.y1 AND c.line_type = 'distribution'), 0)::bigint,
    COALESCE(sum(c.amount_cents) FILTER (WHERE c.effective_date BETWEEN w.y0 AND w.y1 AND c.line_type = 'transfer_in'), 0)::bigint,
    COALESCE(sum(c.amount_cents) FILTER (WHERE c.effective_date BETWEEN w.y0 AND w.y1 AND c.line_type = 'transfer_out'), 0)::bigint,
    COALESCE(sum(c.amount_cents) FILTER (WHERE c.effective_date <= w.y1), 0)::bigint
  FROM public.capital_account_ledger c, w
  WHERE c.property_id = _property AND c.effective_date <= w.y1
  GROUP BY c.member_key
  ORDER BY c.member_key;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 10. Triggers (only on the Month 5 tables that exist) and grants
-- ---------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.owner_capital_contributions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS contribution_to_ledger ON public.owner_capital_contributions;
    CREATE TRIGGER contribution_to_ledger AFTER INSERT ON public.owner_capital_contributions FOR EACH ROW EXECUTE FUNCTION public.post_contribution_entry();
  END IF;
  IF to_regclass('public.expenses') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS expense_to_ledger ON public.expenses;
    CREATE TRIGGER expense_to_ledger AFTER UPDATE OF status ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.expense_status_to_ledger();
  END IF;
  IF to_regclass('public.distribution_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS distribution_to_ledger ON public.distribution_events;
    CREATE TRIGGER distribution_to_ledger AFTER INSERT OR UPDATE OF status ON public.distribution_events FOR EACH ROW EXECUTE FUNCTION public.distribution_status_to_ledger();
  END IF;
  IF to_regclass('public.cap_table_history') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS resale_to_ledger ON public.cap_table_history;
    CREATE TRIGGER resale_to_ledger AFTER INSERT ON public.cap_table_history FOR EACH ROW EXECUTE FUNCTION public.resale_history_to_ledger();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.member_id_from_holder_key(text), public.holder_shares_as_of(uuid, date), public.allocate_cents(uuid, date, bigint), public.expense_account_code(text),
  public.post_expense_allocation(uuid, uuid, jsonb), public.allocate_income(uuid, date, uuid, jsonb), public.post_depreciation(uuid, integer, bigint, text, text, uuid, jsonb),
  public.post_distribution_event(uuid, uuid, jsonb), public.post_resale_transfer(uuid, uuid, jsonb), public.sync_month5_events(uuid, uuid, jsonb), public.capital_roll_forward(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.member_id_from_holder_key(text), public.holder_shares_as_of(uuid, date), public.allocate_cents(uuid, date, bigint), public.expense_account_code(text),
  public.post_expense_allocation(uuid, uuid, jsonb), public.allocate_income(uuid, date, uuid, jsonb), public.post_depreciation(uuid, integer, bigint, text, text, uuid, jsonb),
  public.post_distribution_event(uuid, uuid, jsonb), public.post_resale_transfer(uuid, uuid, jsonb), public.sync_month5_events(uuid, uuid, jsonb), public.capital_roll_forward(uuid, integer)
  TO service_role;
