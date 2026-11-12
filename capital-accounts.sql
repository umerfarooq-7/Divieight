-- divieight — Month 6, Prompt 2: open each LLC's books from the cap table, and connect the capital accounts.
--
-- Run in the Supabase SQL editor AFTER bookkeeping.sql (and owner-dashboard.sql, expenses.sql, money-decisions.sql).
-- Safe to run again.
--
--   1. open_property_ledger: when a property's deed is recorded and its Module 17 cap table is locked, post ONE opening
--      entry (source 'opening'): Property (and capitalized closing costs) and any initial Cash on the debit side, and each
--      member's capital contribution on the credit side, pro rata by cap table shares. A Buyer Account is one member, so
--      a two-member account is ONE capital account; a Hybrid Exit seller's retained shares open a capital account for the
--      seller. Idempotent.
--   2. capital_account_ledger: a derived, append-only projection of posted journal lines on the member accounts.
--      Nothing writes to it directly; it is fed only by a trigger on journal_lines.
--   3. owner_capital_accounts (Month 5) becomes a read model of the ledger: a Month 5 write is captured as a ledger
--      entry, and the ledger keeps the old columns in sync. Existing values are migrated into ledger entries with a reason
--      (reconcile_owner_capital) and every difference is REPORTED, never silently changed.
--   4. backfill_opening_entries: opens the books for every LLC that already closed in testing. Idempotent.
--   5. ledger_balance_check: assets = liabilities + equity (member capital accounts).
--
-- What the numbers are (see the report that came with this file):
--   * Acquisition cost = properties.listing_price (the only price recorded), in dollars, stored here as cents.
--   * Capitalized closing costs = the funded closing_funds_obligations (Month 4), in the same Property asset account.
--   * Initial cash = a figure the Manager passes in (nothing in Month 4 records money left over), 0 by default.
--   * Each member's contribution = (price + closing costs + cash) x their shares / shares on the cap table. Cents that
--     don't divide evenly go one each to the lowest share numbers, so the total is exact.

-- ---------------------------------------------------------------------------------------------------------
-- 1. capital_account_ledger
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.capital_account_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  property_id uuid NOT NULL REFERENCES public.properties(id),
  -- A buyer_account_id, or a seller_id for a Hybrid Exit seller's retained shares.
  member_key uuid NOT NULL,
  entry_id uuid NOT NULL REFERENCES public.journal_entries(id),
  line_id uuid NOT NULL UNIQUE REFERENCES public.journal_lines(id),
  line_type text NOT NULL CHECK (line_type IN ('opening', 'contribution', 'income', 'expense', 'depreciation', 'distribution', 'transfer_in', 'transfer_out')),
  -- Signed: what this line did to the member's capital (a credit adds, a debit takes away).
  amount_cents bigint NOT NULL,
  balance_after_cents bigint NOT NULL,
  effective_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS capital_account_ledger_member_idx ON public.capital_account_ledger (property_id, member_key, seq);

-- Never written directly: only the projection below may insert, and nothing ever updates or deletes.
CREATE OR REPLACE FUNCTION public.capital_ledger_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(current_setting('app.capital_projection', true), '') = 'on' AND pg_trigger_depth() >= 2 THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'capital_account_ledger is derived from the journal and can''t be written directly.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RAISE EXCEPTION 'capital_account_ledger is append-only and derived: it is never changed or deleted.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS capital_ledger_insert_guard ON public.capital_account_ledger;
CREATE TRIGGER capital_ledger_insert_guard BEFORE INSERT ON public.capital_account_ledger FOR EACH ROW EXECUTE FUNCTION public.capital_ledger_guard();
DROP TRIGGER IF EXISTS capital_ledger_change_guard ON public.capital_account_ledger;
CREATE TRIGGER capital_ledger_change_guard BEFORE UPDATE OR DELETE ON public.capital_account_ledger FOR EACH ROW EXECUTE FUNCTION public.capital_ledger_guard();
DROP TRIGGER IF EXISTS capital_ledger_truncate_guard ON public.capital_account_ledger;
CREATE TRIGGER capital_ledger_truncate_guard BEFORE TRUNCATE ON public.capital_account_ledger FOR EACH STATEMENT EXECUTE FUNCTION public.capital_ledger_guard();

ALTER TABLE public.capital_account_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.capital_account_ledger FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.capital_account_ledger TO authenticated, service_role;

-- The Manager reads everything; a member reads their OWN capital account only.
DROP POLICY IF EXISTS "manager and the member read the capital ledger" ON public.capital_account_ledger;
CREATE POLICY "manager and the member read the capital ledger" ON public.capital_account_ledger FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR member_key = auth.uid()
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = capital_account_ledger.member_key AND b.auth_user_id = auth.uid())
  );

-- The projection: every posted line on a member account becomes one row, with the member's running balance.
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
DROP TRIGGER IF EXISTS journal_lines_project_capital ON public.journal_lines;
CREATE TRIGGER journal_lines_project_capital AFTER INSERT ON public.journal_lines FOR EACH ROW EXECUTE FUNCTION public.project_capital_account_line();

-- What the Month 5 columns mean, from the ledger: contributions after the opening, and distributions (a positive number).
CREATE OR REPLACE FUNCTION public.capital_member_totals(_property uuid, _member uuid)
RETURNS TABLE (contributed_cents bigint, distributions_cents bigint, opening_cents bigint, balance_cents bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(sum(amount_cents) FILTER (WHERE line_type = 'contribution'), 0)::bigint,
         COALESCE(-sum(amount_cents) FILTER (WHERE line_type = 'distribution'), 0)::bigint,
         COALESCE(sum(amount_cents) FILTER (WHERE line_type = 'opening'), 0)::bigint,
         COALESCE(sum(amount_cents), 0)::bigint
  FROM public.capital_account_ledger WHERE property_id = _property AND member_key = _member;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 2. Opening entries
-- ---------------------------------------------------------------------------------------------------------
-- Each member (a Buyer Account is ONE member whether it has one person or two) and their pro-rata share, to the cent.
CREATE OR REPLACE FUNCTION public.opening_allocation(_property uuid, _total_cents bigint)
RETURNS TABLE (member_id uuid, shares integer, cents bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH n AS (SELECT count(*) AS n FROM public.cap_table_entries WHERE property_id = _property),
  g AS (
    SELECT COALESCE(buyer_account_id, seller_id) AS m, count(*)::integer AS sh, min(share_number) AS fs
    FROM public.cap_table_entries WHERE property_id = _property GROUP BY COALESCE(buyer_account_id, seller_id)
  ),
  base AS (SELECT g.m, g.sh, g.fs, floor(_total_cents::numeric * g.sh / n.n)::bigint AS c FROM g, n),
  rem AS (SELECT _total_cents - COALESCE(sum(c), 0) AS r FROM base)
  -- The leftover cents (fewer than there are members) go one each to the lowest share numbers.
  SELECT base.m, base.sh, base.c + CASE WHEN row_number() OVER (ORDER BY base.fs) <= (SELECT r FROM rem) THEN 1 ELSE 0 END
  FROM base ORDER BY base.fs;
$$;

CREATE OR REPLACE FUNCTION public.open_property_ledger(_property uuid, _actor uuid DEFAULT NULL, _initial_cash_cents bigint DEFAULT 0, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.properties%ROWTYPE;
  ref text := 'opening:' || _property::text;
  existing uuid;
  locked timestamptz;
  price_cents bigint;
  closing_cents bigint;
  total bigint;
  lines jsonb := '[]'::jsonb;
  holders integer;
  a record;
  new_id uuid;
  drift jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO p FROM public.properties WHERE id = _property;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Property not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF COALESCE(_initial_cash_cents, 0) < 0 THEN
    RAISE EXCEPTION 'Initial cash can''t be negative.' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(ref));

  SELECT id INTO existing FROM public.journal_entries WHERE property_id = _property AND source = 'opening' AND source_ref = ref AND reverses_entry_id IS NULL;

  SELECT cap_table_locked_at INTO locked FROM public.entity_genesis WHERE property_id = _property;
  price_cents := round(COALESCE(p.listing_price, 0) * 100)::bigint;
  SELECT COALESCE(sum(round(amount * 100)), 0)::bigint INTO closing_cents FROM public.closing_funds_obligations WHERE property_id = _property AND status = 'funded';
  total := price_cents + closing_cents + COALESCE(_initial_cash_cents, 0);

  IF existing IS NULL THEN
    IF p.deed_recorded_at IS NULL THEN
      RETURN jsonb_build_object('status', 'not_ready', 'reason', 'The deed has not been recorded yet.');
    END IF;
    IF locked IS NULL THEN
      RETURN jsonb_build_object('status', 'not_ready', 'reason', 'The cap table is not locked yet.');
    END IF;
    IF price_cents <= 0 THEN
      RETURN jsonb_build_object('status', 'not_ready', 'reason', 'The property has no acquisition cost on record.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cap_table_entries WHERE property_id = _property) THEN
      RETURN jsonb_build_object('status', 'not_ready', 'reason', 'The cap table has no shares.');
    END IF;
    IF EXISTS (SELECT 1 FROM public.cap_table_entries WHERE property_id = _property AND buyer_account_id IS NULL AND seller_id IS NULL) THEN
      RETURN jsonb_build_object('status', 'not_ready', 'reason', 'A cap table share has no holder.');
    END IF;
  END IF;

  IF existing IS NOT NULL THEN
    -- Already open: change nothing, but say if the cap table has moved on since.
    FOR a IN SELECT * FROM public.opening_allocation(_property, (SELECT COALESCE(sum(l.credit_cents), 0)::bigint FROM public.journal_lines l JOIN public.coa_accounts c ON c.id = l.account_id WHERE l.entry_id = existing AND c.code = '3000')) LOOP
      IF COALESCE((SELECT sum(l.credit_cents) FROM public.journal_lines l JOIN public.coa_accounts c ON c.id = l.account_id WHERE l.entry_id = existing AND c.code = '3000' AND l.member_id = a.member_id), 0) <> a.cents THEN
        drift := drift || jsonb_build_array(jsonb_build_object('member_id', a.member_id, 'cap_table_cents', a.cents));
      END IF;
    END LOOP;
    RETURN jsonb_build_object('status', 'already_open', 'entry_id', existing, 'cap_table_changed', jsonb_array_length(drift) > 0 OR EXISTS (
      SELECT 1 FROM public.journal_lines l JOIN public.coa_accounts c ON c.id = l.account_id
      WHERE l.entry_id = existing AND c.code = '3000' AND NOT EXISTS (SELECT 1 FROM public.cap_table_entries t WHERE t.property_id = _property AND (t.buyer_account_id = l.member_id OR t.seller_id = l.member_id))), 'differences', drift);
  END IF;

  lines := lines || jsonb_build_array(jsonb_build_object('code', '1200', 'debit_cents', price_cents));
  IF closing_cents > 0 THEN
    lines := lines || jsonb_build_array(jsonb_build_object('code', '1200', 'debit_cents', closing_cents));
  END IF;
  IF COALESCE(_initial_cash_cents, 0) > 0 THEN
    lines := lines || jsonb_build_array(jsonb_build_object('code', '1000', 'debit_cents', _initial_cash_cents));
  END IF;
  holders := 0;
  FOR a IN SELECT * FROM public.opening_allocation(_property, total) LOOP
    holders := holders + 1;
    IF a.cents > 0 THEN
      lines := lines || jsonb_build_array(jsonb_build_object('code', '3000', 'member_id', a.member_id, 'credit_cents', a.cents));
    END IF;
  END LOOP;

  new_id := public.post_entry(_property, lines, jsonb_build_object(
    'source', 'opening', 'source_ref', ref, 'entry_date', COALESCE(p.deed_recorded_at::date, current_date), 'created_by', _actor,
    'memo', 'Opening entry from the locked cap table: Property ' || price_cents || ' cents, closing costs ' || closing_cents || ' cents, cash ' || COALESCE(_initial_cash_cents, 0) || ' cents.',
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  PERFORM public.ledger_audit(_actor, 'ledger.opened', new_id, jsonb_build_object('property_id', _property, 'members', holders, 'property_cents', price_cents, 'closing_cost_cents', closing_cents, 'initial_cash_cents', COALESCE(_initial_cash_cents, 0), 'total_cents', total, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('status', 'opened', 'entry_id', new_id, 'members', holders, 'total_cents', total);
END;
$$;

-- When a deed is recorded on a property whose cap table is locked, open its books. Never blocks the closing: a failure
-- is a warning, and the Manager can open it by hand.
CREATE OR REPLACE FUNCTION public.open_ledger_on_deed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.deed_recorded_at IS NULL AND NEW.deed_recorded_at IS NOT NULL THEN
    BEGIN
      PERFORM public.open_property_ledger(NEW.id, NULL, 0, '{}'::jsonb);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not open the ledger for property %: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS properties_open_ledger ON public.properties;
CREATE TRIGGER properties_open_ledger AFTER UPDATE OF deed_recorded_at ON public.properties FOR EACH ROW EXECUTE FUNCTION public.open_ledger_on_deed();

-- ---------------------------------------------------------------------------------------------------------
-- 3. owner_capital_accounts as a read model of the ledger
-- ---------------------------------------------------------------------------------------------------------
-- Which capital account a user's row belongs to on a property: their Buyer Account, or themselves as a retained seller.
CREATE OR REPLACE FUNCTION public.capital_member_key(_property uuid, _user uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT b.id FROM public.buyer_accounts b WHERE b.auth_user_id = _user
       AND EXISTS (SELECT 1 FROM public.cap_table_entries c WHERE c.property_id = _property AND c.buyer_account_id = b.id) LIMIT 1),
    (SELECT c.seller_id FROM public.cap_table_entries c WHERE c.property_id = _property AND c.seller_id = _user LIMIT 1));
$$;

CREATE OR REPLACE FUNCTION public.ledger_is_open(_property uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.journal_entries WHERE property_id = _property AND source = 'opening' AND reverses_entry_id IS NULL);
$$;

-- The ledger keeps the old columns in sync. If the old row already disagrees with the ledger, it is left alone (and the
-- reconciliation view shows the difference): numbers are never silently changed.
CREATE OR REPLACE FUNCTION public.sync_owner_capital_from_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  holder uuid;
  t record;
  eff_c bigint := 0;
  eff_d bigint := 0;
  cur record;
BEGIN
  IF NEW.line_type NOT IN ('contribution', 'distribution') THEN
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
  PERFORM set_config('app.ledger_sync', 'on', true);
  IF NOT FOUND THEN
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
DROP TRIGGER IF EXISTS capital_ledger_sync_owner ON public.capital_account_ledger;
CREATE TRIGGER capital_ledger_sync_owner AFTER INSERT ON public.capital_account_ledger FOR EACH ROW EXECUTE FUNCTION public.sync_owner_capital_from_ledger();

-- A Month 5 write (a capital call or an expense payment bumping the running total) is captured as a ledger entry, so the
-- table and the ledger move together. If the ledger refuses (a closed period, say) the old value stays and the
-- reconciliation view reports the difference.
CREATE OR REPLACE FUNCTION public.capture_owner_capital_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  member uuid;
  t record;
  dc bigint;
  dd bigint;
BEGIN
  IF COALESCE(current_setting('app.ledger_sync', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF NOT public.ledger_is_open(NEW.property_id) THEN
    RETURN NULL;
  END IF;
  member := public.capital_member_key(NEW.property_id, NEW.user_id);
  IF member IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO t FROM public.capital_member_totals(NEW.property_id, member);
  dc := round(NEW.contributed_amount * 100)::bigint - t.contributed_cents;
  dd := round(NEW.distributions_amount * 100)::bigint - t.distributions_cents;
  BEGIN
    IF dc <> 0 THEN
      PERFORM public.post_entry(NEW.property_id,
        CASE WHEN dc > 0 THEN jsonb_build_array(jsonb_build_object('code', '1000', 'debit_cents', dc), jsonb_build_object('code', '3000', 'member_id', member, 'credit_cents', dc))
             ELSE jsonb_build_array(jsonb_build_object('code', '3000', 'member_id', member, 'debit_cents', -dc), jsonb_build_object('code', '1000', 'credit_cents', -dc)) END,
        jsonb_build_object('source', 'capital_call', 'source_ref', 'owner_capital_accounts:' || NEW.id::text, 'memo', 'Contribution recorded in owner_capital_accounts'));
    END IF;
    IF dd <> 0 THEN
      PERFORM public.post_entry(NEW.property_id,
        CASE WHEN dd > 0 THEN jsonb_build_array(jsonb_build_object('code', '3100', 'member_id', member, 'debit_cents', dd), jsonb_build_object('code', '1000', 'credit_cents', dd))
             ELSE jsonb_build_array(jsonb_build_object('code', '1000', 'debit_cents', -dd), jsonb_build_object('code', '3100', 'member_id', member, 'credit_cents', -dd)) END,
        jsonb_build_object('source', 'distribution', 'source_ref', 'owner_capital_accounts:' || NEW.id::text, 'memo', 'Distribution recorded in owner_capital_accounts'));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Ledger could not take the owner_capital_accounts change for property % (%): it is left as is and shows in owner_capital_reconciliation.', NEW.property_id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS owner_capital_accounts_to_ledger ON public.owner_capital_accounts;
CREATE TRIGGER owner_capital_accounts_to_ledger AFTER INSERT OR UPDATE ON public.owner_capital_accounts FOR EACH ROW EXECUTE FUNCTION public.capture_owner_capital_write();

-- The report: the Month 5 table beside the ledger. matches is false wherever they differ. Nothing here changes a number.
CREATE OR REPLACE VIEW public.owner_capital_reconciliation WITH (security_invoker = true) AS
SELECT o.property_id, o.user_id, public.capital_member_key(o.property_id, o.user_id) AS member_key,
       round(o.contributed_amount * 100)::bigint AS table_contributed_cents, t.contributed_cents AS ledger_contributed_cents,
       round(o.distributions_amount * 100)::bigint AS table_distributions_cents, t.distributions_cents AS ledger_distributions_cents,
       t.opening_cents, t.balance_cents AS capital_balance_cents,
       public.capital_member_key(o.property_id, o.user_id) IS NOT NULL
         AND round(o.contributed_amount * 100)::bigint = t.contributed_cents
         AND round(o.distributions_amount * 100)::bigint = t.distributions_cents AS matches
FROM public.owner_capital_accounts o
LEFT JOIN LATERAL public.capital_member_totals(o.property_id, COALESCE(public.capital_member_key(o.property_id, o.user_id), o.user_id)) t ON true;
REVOKE ALL ON public.owner_capital_reconciliation FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.owner_capital_reconciliation TO service_role;

-- Bring existing Month 5 values into the ledger, with a reason. Returns every difference it found and what it posted.
-- The owner_capital_accounts numbers themselves are not changed.
CREATE OR REPLACE FUNCTION public.reconcile_owner_capital(_property uuid, _actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o record;
  member uuid;
  t record;
  dc bigint;
  dd bigint;
  posted uuid;
  report jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.ledger_is_open(_property) THEN
    RETURN jsonb_build_object('status', 'not_open');
  END IF;
  FOR o IN SELECT * FROM public.owner_capital_accounts WHERE property_id = _property ORDER BY user_id LOOP
    member := public.capital_member_key(_property, o.user_id);
    IF member IS NULL THEN
      report := report || jsonb_build_array(jsonb_build_object('user_id', o.user_id, 'problem', 'no capital account for this user on this property', 'table_contributed_cents', round(o.contributed_amount * 100)::bigint, 'table_distributions_cents', round(o.distributions_amount * 100)::bigint));
      CONTINUE;
    END IF;
    SELECT * INTO t FROM public.capital_member_totals(_property, member);
    dc := round(o.contributed_amount * 100)::bigint - t.contributed_cents;
    dd := round(o.distributions_amount * 100)::bigint - t.distributions_cents;
    IF dc = 0 AND dd = 0 THEN
      CONTINUE;
    END IF;
    PERFORM set_config('app.ledger_sync', 'on', true);
    IF dc <> 0 THEN
      posted := public.post_entry(_property,
        CASE WHEN dc > 0 THEN jsonb_build_array(jsonb_build_object('code', '1000', 'debit_cents', dc), jsonb_build_object('code', '3000', 'member_id', member, 'credit_cents', dc))
             ELSE jsonb_build_array(jsonb_build_object('code', '3000', 'member_id', member, 'debit_cents', -dc), jsonb_build_object('code', '1000', 'credit_cents', -dc)) END,
        jsonb_build_object('source', 'system', 'source_ref', 'migrate-contributed:' || _property::text || ':' || member::text, 'created_by', _actor,
          'memo', 'Migrated from owner_capital_accounts (Month 5 running total): contributions of ' || (round(o.contributed_amount * 100)::bigint) || ' cents against ' || t.contributed_cents || ' in the ledger.'));
      report := report || jsonb_build_array(jsonb_build_object('user_id', o.user_id, 'member_key', member, 'kind', 'contributed', 'table_cents', round(o.contributed_amount * 100)::bigint, 'ledger_cents_before', t.contributed_cents, 'difference_cents', dc, 'posted_entry', posted));
    END IF;
    IF dd <> 0 THEN
      posted := public.post_entry(_property,
        CASE WHEN dd > 0 THEN jsonb_build_array(jsonb_build_object('code', '3100', 'member_id', member, 'debit_cents', dd), jsonb_build_object('code', '1000', 'credit_cents', dd))
             ELSE jsonb_build_array(jsonb_build_object('code', '1000', 'debit_cents', -dd), jsonb_build_object('code', '3100', 'member_id', member, 'credit_cents', -dd)) END,
        jsonb_build_object('source', 'system', 'source_ref', 'migrate-distributions:' || _property::text || ':' || member::text, 'created_by', _actor,
          'memo', 'Migrated from owner_capital_accounts (Month 5 running total): distributions of ' || (round(o.distributions_amount * 100)::bigint) || ' cents against ' || t.distributions_cents || ' in the ledger.'));
      report := report || jsonb_build_array(jsonb_build_object('user_id', o.user_id, 'member_key', member, 'kind', 'distributions', 'table_cents', round(o.distributions_amount * 100)::bigint, 'ledger_cents_before', t.distributions_cents, 'difference_cents', dd, 'posted_entry', posted));
    END IF;
    PERFORM set_config('app.ledger_sync', 'off', true);
  END LOOP;
  IF jsonb_array_length(report) > 0 THEN
    PERFORM public.ledger_audit(_actor, 'ledger.owner_capital_reconciled', _property, jsonb_build_object('property_id', _property, 'differences', report));
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'differences', report);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. Backfill
-- ---------------------------------------------------------------------------------------------------------
-- Every LLC that already closed (deed recorded, cap table locked): open its books once, then bring its Month 5 totals in.
-- Run it twice and the second run creates nothing.
CREATE OR REPLACE FUNCTION public.backfill_opening_entries(_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p record;
  results jsonb := '[]'::jsonb;
  opened jsonb;
  rec jsonb;
BEGIN
  FOR p IN SELECT id FROM public.properties WHERE deed_recorded_at IS NOT NULL ORDER BY created_at, id LOOP
    BEGIN
      opened := public.open_property_ledger(p.id, _actor, 0, '{}'::jsonb);
      rec := public.reconcile_owner_capital(p.id, _actor);
      results := results || jsonb_build_array(jsonb_build_object('property_id', p.id, 'opening', opened, 'reconciliation', rec));
    EXCEPTION WHEN OTHERS THEN
      results := results || jsonb_build_array(jsonb_build_object('property_id', p.id, 'error', SQLERRM));
    END;
  END LOOP;
  RETURN results;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. Assets = liabilities + equity
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ledger_balance_check(_property uuid, _as_of date DEFAULT current_date)
RETURNS TABLE (assets_cents bigint, liabilities_cents bigint, equity_cents bigint, net_income_cents bigint, member_capital_cents bigint, balanced boolean)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH s AS (
    SELECT a.type, COALESCE(sum(l.debit_cents), 0) AS d, COALESCE(sum(l.credit_cents), 0) AS c
    FROM public.journal_entries e
    JOIN public.journal_lines l ON l.entry_id = e.id
    JOIN public.coa_accounts a ON a.id = l.account_id
    WHERE e.property_id = _property AND e.entry_date <= _as_of
    GROUP BY a.type
  ), t AS (
    SELECT COALESCE(sum(d - c) FILTER (WHERE type = 'asset'), 0)::bigint AS assets,
           COALESCE(sum(c - d) FILTER (WHERE type = 'liability'), 0)::bigint AS liabilities,
           COALESCE(sum(c - d) FILTER (WHERE type = 'equity'), 0)::bigint AS equity,
           (COALESCE(sum(c - d) FILTER (WHERE type = 'income'), 0) - COALESCE(sum(d - c) FILTER (WHERE type = 'expense'), 0))::bigint AS net_income
    FROM s
  )
  SELECT t.assets, t.liabilities, t.equity, t.net_income,
         (SELECT COALESCE(sum(amount_cents), 0)::bigint FROM public.capital_account_ledger WHERE property_id = _property AND effective_date <= _as_of),
         t.assets = t.liabilities + t.equity + t.net_income
  FROM t;
$$;

REVOKE ALL ON FUNCTION public.open_property_ledger(uuid, uuid, bigint, jsonb), public.reconcile_owner_capital(uuid, uuid), public.backfill_opening_entries(uuid),
  public.opening_allocation(uuid, bigint), public.capital_member_totals(uuid, uuid), public.capital_member_key(uuid, uuid), public.ledger_is_open(uuid),
  public.ledger_balance_check(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_property_ledger(uuid, uuid, bigint, jsonb), public.reconcile_owner_capital(uuid, uuid), public.backfill_opening_entries(uuid),
  public.opening_allocation(uuid, bigint), public.capital_member_totals(uuid, uuid), public.capital_member_key(uuid, uuid), public.ledger_is_open(uuid),
  public.ledger_balance_check(uuid, date) TO service_role;
