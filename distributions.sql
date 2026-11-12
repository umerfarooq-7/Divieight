-- Month 6, Prompt 9: real, authorized distributions. Nothing moves real money: the ACH rail is a simulated adapter (src/lib/disbursement-adapters).
-- Run in the Supabase SQL editor AFTER owner-notifications.sql, money-decisions.sql, bookkeeping.sql, capital-accounts.sql, books.sql,
-- capital-events.sql and expense-books.sql. Safe to run again.
--
--   1. The Manager initiates a distribution (property, total, record date, reason). It is refused above the DISTRIBUTABLE CASH:
--      the Cash ledger balance, minus the property's minimum reserve, minus what authorized distributions already owe.
--   2. Per-member amounts: pro rata to the shares held ON THE RECORD DATE (cap_table_history), or per an Operating Agreement
--      override (percentages + the OA section). Cents rounded down, leftover cents to rank 1 (the Prompt 8 rule). The split is
--      worked out by the app (so the Manager can preview it) and CHECKED here, line by line.
--   3. draft -> authorized (the Manager's typed signature, verified on the server) -> executed | failed | voided.
--   4. Execution pays each member through the adapter. A member without a payout method is HELD (not paid, not blocking anyone else).
--   5. Each payment that goes out posts ONE journal entry (Dr 3100 Member Distributions for that member, Cr 1000 Cash). A failed
--      payment posts nothing. capital_account_ledger and owner_capital_accounts follow the journal, exactly once.
--   6. Void and re-post keeps every version: voiding reverses the entries that were posted, the corrected one posts new ones.
--   7. Nothing here looks at the Retention Lock or at overdue expenses: neither blocks a distribution.
--   8. Every step is written to the audit log.

-- ---------------------------------------------------------------------------------------------------------
-- 1. The record
-- ---------------------------------------------------------------------------------------------------------
-- 'notice' is a Month 5 distribution (a notice only, posted at once); 'payout' is the new flow.
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS workflow text NOT NULL DEFAULT 'notice';
ALTER TABLE public.distribution_events DROP CONSTRAINT IF EXISTS distribution_events_workflow_check;
ALTER TABLE public.distribution_events ADD CONSTRAINT distribution_events_workflow_check CHECK (workflow IN ('notice', 'payout'));
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS total_cents bigint;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS split_method text;
ALTER TABLE public.distribution_events DROP CONSTRAINT IF EXISTS distribution_events_split_method_check;
ALTER TABLE public.distribution_events ADD CONSTRAINT distribution_events_split_method_check CHECK (split_method IS NULL OR split_method IN ('pro_rata', 'oa_override'));
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS override_percents jsonb;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS override_oa_section text;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS cash_cents bigint;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS reserve_cents bigint;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS distributable_cents bigint;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS authorized_by uuid;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS authorized_at timestamptz;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS authorized_signature text;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS executed_at timestamptz;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS failed_at timestamptz;
ALTER TABLE public.distribution_events ADD COLUMN IF NOT EXISTS failure_reason text;
ALTER TABLE public.distribution_events DROP CONSTRAINT IF EXISTS distribution_events_status_check;
ALTER TABLE public.distribution_events ADD CONSTRAINT distribution_events_status_check CHECK (status IN ('posted', 'voided', 'draft', 'authorized', 'executed', 'failed'));

-- Who gets what, and whether it has gone out. One row per member per distribution, made when the Manager authorizes.
CREATE TABLE IF NOT EXISTS public.distribution_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  distribution_id uuid NOT NULL REFERENCES public.distribution_events(id),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  holder_key text NOT NULL,
  member_id uuid NOT NULL,
  shares integer NOT NULL CHECK (shares > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  -- pending: waiting to be sent. held: the member has no payout method yet. processing: with the bank. sent: paid and posted.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'held', 'processing', 'sent', 'failed', 'cancelled')),
  payout_method_id uuid,
  bank_last4 text CHECK (bank_last4 IS NULL OR bank_last4 ~ '^[0-9]{4}$'),
  adapter_ref text,
  failure_reason text,
  attempts integer NOT NULL DEFAULT 0,
  held_notified_at timestamptz,
  sent_at timestamptz,
  entry_id uuid REFERENCES public.journal_entries(id),
  reversed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (distribution_id, holder_key)
);
CREATE INDEX IF NOT EXISTS distribution_payments_property_idx ON public.distribution_payments (property_id, status);

-- A member's payout method, created by the member. The bank details are tokenized by the adapter: only the token and the last four
-- digits are stored here, never a full number. One active method per holder.
CREATE TABLE IF NOT EXISTS public.member_payout_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holder_key text NOT NULL,
  created_by uuid NOT NULL,
  bank_name text,
  token text NOT NULL CHECK (token ~ '^tok_[A-Za-z0-9_]{8,}$'),
  last4 text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS member_payout_methods_one_active ON public.member_payout_methods (holder_key) WHERE status = 'active';

-- The minimum reserve a property keeps in Cash. ASSUMPTION (flagged on the launch readiness page): the default is a placeholder.
CREATE TABLE IF NOT EXISTS public.distribution_settings (
  property_id uuid PRIMARY KEY REFERENCES public.properties(id) ON DELETE CASCADE,
  minimum_reserve_cents bigint NOT NULL CHECK (minimum_reserve_cents >= 0),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A payment that has gone out is never deleted.
CREATE OR REPLACE FUNCTION public.distribution_payments_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A distribution payment is never deleted.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.distribution_id <> OLD.distribution_id OR NEW.holder_key <> OLD.holder_key OR NEW.amount_cents <> OLD.amount_cents OR NEW.member_id <> OLD.member_id THEN
    RAISE EXCEPTION 'A distribution payment can''t be edited.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'sent' AND NEW.status NOT IN ('sent', 'cancelled') THEN
    RAISE EXCEPTION 'A payment that was sent stays sent.' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS distribution_payments_history ON public.distribution_payments;
CREATE TRIGGER distribution_payments_history BEFORE UPDATE OR DELETE ON public.distribution_payments
  FOR EACH ROW EXECUTE FUNCTION public.distribution_payments_guard();

-- The history guard from money-decisions.sql, now aware of the new flow. A voided distribution stays voided; a payout
-- distribution's terms never change once made, only its status moves, and only forward.
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
  IF OLD.workflow = 'notice' THEN
    IF OLD.status = 'posted' AND (NEW.total_amount <> OLD.total_amount OR NEW.record_date <> OLD.record_date OR NEW.property_id <> OLD.property_id) THEN
      RAISE EXCEPTION 'A posted distribution can''t be edited. Void it and post a corrected one.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.workflow <> OLD.workflow OR NEW.property_id <> OLD.property_id OR NEW.total_amount <> OLD.total_amount OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
     OR NEW.record_date <> OLD.record_date OR NEW.lines IS DISTINCT FROM OLD.lines OR NEW.split_method IS DISTINCT FROM OLD.split_method
     OR NEW.override_percents IS DISTINCT FROM OLD.override_percents OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'A distribution can''t be edited. Void it and make a corrected one.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('authorized', 'voided'))
    OR (OLD.status = 'authorized' AND NEW.status IN ('executed', 'failed', 'voided'))
    OR (OLD.status = 'executed' AND NEW.status = 'voided')
    OR (OLD.status = 'failed' AND NEW.status IN ('authorized', 'executed', 'voided'))) THEN
    RAISE EXCEPTION 'A distribution can''t go from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- The Month 5 ledger trigger posts a 'posted' notice at once. A payout distribution posts nothing on its own: each payment posts when it goes out.
CREATE OR REPLACE FUNCTION public.distribution_status_to_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ref text := 'distribution:' || NEW.id::text;
  entry uuid;
BEGIN
  IF NEW.workflow = 'payout' THEN
    RETURN NULL;
  END IF;
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
-- 2. Helpers
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.default_minimum_reserve_cents()
RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT 100000::bigint $$; -- ASSUMPTION: $1,000 until the Operating Agreement or the Manager says otherwise.

CREATE OR REPLACE FUNCTION public.minimum_reserve_cents(_property uuid)
RETURNS bigint LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE((SELECT minimum_reserve_cents FROM public.distribution_settings WHERE property_id = _property), public.default_minimum_reserve_cents());
$$;

CREATE OR REPLACE FUNCTION public.distribution_audit(_actor uuid, _action text, _id uuid, _meta jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, CASE WHEN _actor IS NULL THEN 'system' ELSE 'admin' END, _action, 'distribution_event', _id::text,
          _meta || jsonb_build_object('at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
END;
$$;

CREATE OR REPLACE FUNCTION public.distribution_require_manager(_actor uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can do that.' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- Is the period this entry would land in open? (post_entry refuses a closed one, and by then the money would have gone.)
CREATE OR REPLACE FUNCTION public.ledger_period_is_open(_property uuid, _date date)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.accounting_periods WHERE property_id = _property AND year = extract(year FROM _date)::int AND month = extract(month FROM _date)::int AND status = 'closed');
$$;

-- The cash a distribution may draw on: the Cash ledger balance, minus the minimum reserve, minus what other authorized distributions
-- still owe (payments not yet paid). _exclude leaves one distribution out (itself).
CREATE OR REPLACE FUNCTION public.distributable_cash(_property uuid, _exclude uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  cash bigint;
  reserve bigint := public.minimum_reserve_cents(_property);
  committed bigint;
BEGIN
  SELECT COALESCE(sum(l.debit_cents) - sum(l.credit_cents), 0)::bigint INTO cash
  FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
  WHERE e.property_id = _property AND a.code = '1000';
  SELECT COALESCE(sum(p.amount_cents), 0)::bigint INTO committed
  FROM public.distribution_payments p JOIN public.distribution_events d ON d.id = p.distribution_id
  WHERE p.property_id = _property AND p.status IN ('pending', 'held', 'processing') AND d.status IN ('authorized', 'executed', 'failed')
    AND (_exclude IS NULL OR p.distribution_id <> _exclude);
  RETURN jsonb_build_object('cash_cents', cash, 'reserve_cents', reserve, 'committed_cents', committed, 'distributable_cents', cash - reserve - committed);
END;
$$;

-- Set the minimum reserve (Manager only).
CREATE OR REPLACE FUNCTION public.set_minimum_reserve(_property uuid, _cents bigint, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE before bigint := public.minimum_reserve_cents(_property);
BEGIN
  PERFORM public.distribution_require_manager(_actor);
  IF _cents IS NULL OR _cents < 0 THEN
    RAISE EXCEPTION 'The minimum reserve can''t be negative.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.distribution_settings (property_id, minimum_reserve_cents, updated_by, updated_at) VALUES (_property, _cents, _actor, now())
  ON CONFLICT (property_id) DO UPDATE SET minimum_reserve_cents = EXCLUDED.minimum_reserve_cents, updated_by = EXCLUDED.updated_by, updated_at = now();
  PERFORM public.distribution_audit(_actor, 'distribution.reserve_set', _property, jsonb_build_object('property_id', _property, 'before_cents', before, 'after_cents', _cents, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Initiate: the draft, with every check
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_distribution(
  _property uuid, _total_cents bigint, _record_date date, _reason text, _split_method text, _override jsonb, _lines jsonb, _actor uuid,
  _meta jsonb DEFAULT '{}'::jsonb, _replaces uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cash jsonb;
  max_cents bigint;
  l jsonb;
  holder record;
  n_lines integer;
  n_holders integer;
  issued integer;
  cents bigint;
  floor_cents bigint;
  pct numeric;
  sum_cents bigint := 0;
  old public.distribution_events%ROWTYPE;
  new_id uuid;
BEGIN
  PERFORM public.distribution_require_manager(_actor);
  IF NOT public.ledger_is_open(_property) THEN
    RAISE EXCEPTION 'The books for this property are not open yet.' USING ERRCODE = 'check_violation';
  END IF;
  IF _total_cents IS NULL OR _total_cents <= 0 THEN
    RAISE EXCEPTION 'The total must be above zero.' USING ERRCODE = 'check_violation';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'Say why this distribution is being made.' USING ERRCODE = 'check_violation';
  END IF;
  IF _record_date IS NULL OR _record_date > current_date THEN
    RAISE EXCEPTION 'The record date can''t be in the future.' USING ERRCODE = 'check_violation';
  END IF;
  IF _split_method NOT IN ('pro_rata', 'oa_override') THEN
    RAISE EXCEPTION 'The split is pro rata or an Operating Agreement override.' USING ERRCODE = 'check_violation';
  END IF;
  IF _split_method = 'oa_override' THEN
    IF NOT public.override_percents_ok(_override) THEN
      RAISE EXCEPTION 'The override percentages must each be above zero, with at most two decimals, and add up to exactly 100.' USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(btrim(_override->>'oa_section'), '') = '' THEN
      RAISE EXCEPTION 'Name the Operating Agreement section the override comes from.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Never more than the distributable cash.
  cash := public.distributable_cash(_property);
  max_cents := GREATEST((cash->>'distributable_cents')::bigint, 0);
  IF _total_cents > max_cents THEN
    RAISE EXCEPTION 'That is more than the distributable cash: % cents against % cents (cash % cents, minimum reserve % cents, already committed % cents).',
      _total_cents, max_cents, cash->>'cash_cents', cash->>'reserve_cents', cash->>'committed_cents' USING ERRCODE = 'check_violation';
  END IF;

  -- The lines: exactly the holders on the record date, each paid what the rule gives (to within the leftover cents), adding up to the total.
  IF jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'The distribution has no lines.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), COALESCE(sum(shares), 0) INTO n_holders, issued FROM public.holder_shares_as_of(_property, _record_date);
  n_lines := jsonb_array_length(_lines);
  IF n_lines <> n_holders THEN
    RAISE EXCEPTION 'The lines must be exactly the holders on the record date.' USING ERRCODE = 'check_violation';
  END IF;
  IF _split_method = 'oa_override' AND (SELECT count(*) FROM jsonb_object_keys(_override->'percents')) <> n_holders THEN
    RAISE EXCEPTION 'The override must name every holder on the record date.' USING ERRCODE = 'check_violation';
  END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO holder FROM public.holder_shares_as_of(_property, _record_date) h WHERE h.member_id = public.member_id_from_holder_key(l->>'holder_key');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A line names someone who did not hold shares on the record date.' USING ERRCODE = 'check_violation';
    END IF;
    IF (l->>'share_count')::integer <> holder.shares THEN
      RAISE EXCEPTION 'A line''s share count is not what the holder held on the record date.' USING ERRCODE = 'check_violation';
    END IF;
    cents := round((l->>'amount')::numeric * 100)::bigint;
    IF _split_method = 'pro_rata' THEN
      floor_cents := floor(_total_cents::numeric * holder.shares / issued)::bigint;
    ELSE
      IF NOT (_override->'percents' ? (l->>'holder_key')) THEN
        RAISE EXCEPTION 'The override does not name every holder.' USING ERRCODE = 'check_violation';
      END IF;
      pct := (_override->'percents'->>(l->>'holder_key'))::numeric;
      floor_cents := floor(_total_cents::numeric * round(pct * 100) / 10000)::bigint;
    END IF;
    -- Rounded down to the cent; at most 7 leftover cents (a property has at most 8 holders), all to rank 1.
    IF cents < floor_cents OR cents > floor_cents + 7 THEN
      RAISE EXCEPTION 'A line is not what the split rule gives.' USING ERRCODE = 'check_violation';
    END IF;
    IF cents <= 0 THEN
      RAISE EXCEPTION 'This amount is too small to split across every holder.' USING ERRCODE = 'check_violation';
    END IF;
    sum_cents := sum_cents + cents;
  END LOOP;
  IF (SELECT count(DISTINCT x->>'holder_key') FROM jsonb_array_elements(_lines) x) <> n_lines THEN
    RAISE EXCEPTION 'A holder appears twice.' USING ERRCODE = 'check_violation';
  END IF;
  IF sum_cents <> _total_cents THEN
    RAISE EXCEPTION 'The lines add up to % cents, not the total of % cents.', sum_cents, _total_cents USING ERRCODE = 'check_violation';
  END IF;

  IF _replaces IS NOT NULL THEN
    SELECT * INTO old FROM public.distribution_events WHERE id = _replaces AND property_id = _property AND workflow = 'payout';
    IF NOT FOUND OR old.status <> 'voided' OR old.replaced_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only a voided distribution that has not been replaced can be replaced.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  INSERT INTO public.distribution_events (property_id, total_amount, total_cents, record_date, note, reason, created_by, status, workflow, lines, split_method,
      override_percents, override_oa_section, cash_cents, reserve_cents, distributable_cents, replaces_id)
  VALUES (_property, _total_cents / 100.0, _total_cents, _record_date, NULL, btrim(_reason), _actor, 'draft', 'payout', _lines, _split_method,
      CASE WHEN _split_method = 'oa_override' THEN _override->'percents' END, CASE WHEN _split_method = 'oa_override' THEN btrim(_override->>'oa_section') END,
      (cash->>'cash_cents')::bigint, (cash->>'reserve_cents')::bigint, max_cents, _replaces)
  RETURNING id INTO new_id;
  IF _replaces IS NOT NULL THEN
    UPDATE public.distribution_events SET replaced_by_id = new_id WHERE id = _replaces;
  END IF;
  PERFORM public.distribution_audit(_actor, 'distribution.created', new_id, jsonb_build_object('property_id', _property, 'total_cents', _total_cents, 'record_date', _record_date,
    'split_method', _split_method, 'oa_section', _override->>'oa_section', 'lines', _lines, 'cash_cents', cash->>'cash_cents', 'reserve_cents', cash->>'reserve_cents',
    'distributable_cents', max_cents, 'replaces_id', _replaces, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN new_id;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. Authorize: the Manager's typed signature (verified on the server against the Manager's own name)
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.authorize_distribution(_id uuid, _signed_name text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d public.distribution_events%ROWTYPE;
  cash jsonb;
  l jsonb;
BEGIN
  PERFORM public.distribution_require_manager(_actor);
  SELECT * INTO d FROM public.distribution_events WHERE id = _id AND workflow = 'payout' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Distribution not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF d.status <> 'draft' THEN
    RETURN jsonb_build_object('status', 'not_draft', 'current', d.status);
  END IF;
  IF _signed_name IS NULL OR btrim(_signed_name) = '' THEN
    RAISE EXCEPTION 'Sign with your full name to authorize.' USING ERRCODE = 'check_violation';
  END IF;
  -- The cash is checked again at the moment of authorizing: it may have moved since the draft.
  cash := public.distributable_cash(d.property_id, d.id);
  IF d.total_cents > GREATEST((cash->>'distributable_cents')::bigint, 0) THEN
    RAISE EXCEPTION 'That is now more than the distributable cash (% cents available).', GREATEST((cash->>'distributable_cents')::bigint, 0) USING ERRCODE = 'check_violation';
  END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(d.lines) LOOP
    INSERT INTO public.distribution_payments (distribution_id, property_id, holder_key, member_id, shares, amount_cents)
    VALUES (d.id, d.property_id, l->>'holder_key', public.member_id_from_holder_key(l->>'holder_key'), (l->>'share_count')::integer, round((l->>'amount')::numeric * 100)::bigint)
    ON CONFLICT (distribution_id, holder_key) DO NOTHING;
  END LOOP;
  UPDATE public.distribution_events SET status = 'authorized', authorized_by = _actor, authorized_at = now(), authorized_signature = btrim(_signed_name) WHERE id = d.id;
  PERFORM public.distribution_audit(_actor, 'distribution.authorized', d.id, jsonb_build_object('property_id', d.property_id, 'total_cents', d.total_cents, 'signed_name', btrim(_signed_name),
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('status', 'authorized');
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. Execute: claim what can be sent, record each result, finalize
-- ---------------------------------------------------------------------------------------------------------
-- With _holder_key it claims only that member's HELD payments (the member just added a payout method); the rest of the distribution waits for the Manager.
-- Claims the payments that can go out NOW (pending, or held whose member has since added a payout method) by marking them
-- 'processing', so a second call cannot send them again. Those whose member has no payout method are marked held. Returns what to send.
CREATE OR REPLACE FUNCTION public.claim_distribution_payments(_id uuid, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb, _holder_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d public.distribution_events%ROWTYPE;
  p public.distribution_payments%ROWTYPE;
  m public.member_payout_methods%ROWTYPE;
  send jsonb := '[]'::jsonb;
  held jsonb := '[]'::jsonb;
  cash jsonb;
  payable bigint := 0;
BEGIN
  -- The Manager, or the system releasing a payment the Manager already authorized (a held member added a payout method).
  IF _actor IS NOT NULL THEN
    PERFORM public.distribution_require_manager(_actor);
  END IF;
  SELECT * INTO d FROM public.distribution_events WHERE id = _id AND workflow = 'payout' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Distribution not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF d.status NOT IN ('authorized', 'executed') THEN
    RAISE EXCEPTION 'Only an authorized distribution can be executed (this one is %).', d.status USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.ledger_is_open(d.property_id) THEN
    RAISE EXCEPTION 'The books for this property are not open.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.ledger_period_is_open(d.property_id, current_date) THEN
    RAISE EXCEPTION 'The accounting period for today is closed, so nothing can be paid out and posted. Nothing was sent.' USING ERRCODE = 'check_violation';
  END IF;
  -- Cash must cover what goes out now (the reserve stays; this distribution's own payments are not counted against itself).
  FOR p IN SELECT * FROM public.distribution_payments WHERE distribution_id = d.id AND ((_holder_key IS NULL AND status IN ('pending', 'held')) OR (_holder_key IS NOT NULL AND holder_key = _holder_key AND status = 'held')) ORDER BY holder_key FOR UPDATE LOOP
    SELECT * INTO m FROM public.member_payout_methods WHERE holder_key = p.holder_key AND status = 'active';
    IF FOUND THEN
      payable := payable + p.amount_cents;
    END IF;
  END LOOP;
  cash := public.distributable_cash(d.property_id, d.id);
  IF payable > GREATEST((cash->>'distributable_cents')::bigint, 0) THEN
    RAISE EXCEPTION 'The distributable cash (% cents) no longer covers these payments (% cents). Nothing was sent.', GREATEST((cash->>'distributable_cents')::bigint, 0), payable USING ERRCODE = 'check_violation';
  END IF;
  FOR p IN SELECT * FROM public.distribution_payments WHERE distribution_id = d.id AND ((_holder_key IS NULL AND status IN ('pending', 'held')) OR (_holder_key IS NOT NULL AND holder_key = _holder_key AND status = 'held')) ORDER BY holder_key FOR UPDATE LOOP
    SELECT * INTO m FROM public.member_payout_methods WHERE holder_key = p.holder_key AND status = 'active';
    IF FOUND THEN
      UPDATE public.distribution_payments SET status = 'processing', payout_method_id = m.id, bank_last4 = m.last4, attempts = attempts + 1, failure_reason = NULL WHERE id = p.id;
      send := send || jsonb_build_array(jsonb_build_object('payment_id', p.id, 'holder_key', p.holder_key, 'amount_cents', p.amount_cents, 'token', m.token, 'last4', m.last4));
    ELSE
      IF p.status = 'pending' THEN
        UPDATE public.distribution_payments SET status = 'held' WHERE id = p.id;
        held := held || jsonb_build_array(jsonb_build_object('payment_id', p.id, 'holder_key', p.holder_key, 'amount_cents', p.amount_cents));
      END IF;
    END IF;
  END LOOP;
  PERFORM public.distribution_audit(_actor, 'distribution.execution_started', d.id, jsonb_build_object('property_id', d.property_id, 'to_send', jsonb_array_length(send), 'newly_held', jsonb_array_length(held),
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('send', send, 'held', held);
END;
$$;

-- One payment's outcome from the adapter. 'sent' posts the journal entry (Dr 3100 for the member, Cr 1000 Cash) and moves the capital account;
-- 'failed' posts nothing; 'processing' keeps it with the bank. Once a payment is sent or failed, asking again changes nothing.
CREATE OR REPLACE FUNCTION public.record_payment_result(_payment uuid, _state text, _ref text, _reason text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p public.distribution_payments%ROWTYPE;
  d public.distribution_events%ROWTYPE;
  entry uuid;
BEGIN
  IF _actor IS NOT NULL THEN
    PERFORM public.distribution_require_manager(_actor);
  END IF;
  SELECT * INTO p FROM public.distribution_payments WHERE id = _payment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p.status IN ('sent', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object('status', 'already_' || p.status);
  END IF;
  IF p.status <> 'processing' THEN
    RAISE EXCEPTION 'This payment was not sent to the bank (it is %).', p.status USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO d FROM public.distribution_events WHERE id = p.distribution_id;
  IF _state = 'sent' THEN
    entry := public.post_entry(p.property_id,
      jsonb_build_array(jsonb_build_object('code', '3100', 'member_id', p.member_id, 'debit_cents', p.amount_cents), jsonb_build_object('code', '1000', 'credit_cents', p.amount_cents)),
      jsonb_build_object('source', 'distribution', 'source_ref', 'distribution:' || p.distribution_id::text || ':' || p.holder_key, 'entry_date', current_date,
        'memo', 'Distribution paid by ACH (record date ' || d.record_date || ')', 'created_by', _actor, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
    UPDATE public.distribution_payments SET status = 'sent', adapter_ref = COALESCE(_ref, adapter_ref), sent_at = now(), entry_id = entry, failure_reason = NULL WHERE id = p.id;
    PERFORM public.distribution_audit(_actor, 'distribution.payment_sent', p.distribution_id, jsonb_build_object('property_id', p.property_id, 'payment_id', p.id, 'holder_key', p.holder_key,
      'amount_cents', p.amount_cents, 'last4', p.bank_last4, 'adapter_ref', _ref, 'entry_id', entry));
    RETURN jsonb_build_object('status', 'sent', 'entry_id', entry);
  ELSIF _state = 'failed' THEN
    UPDATE public.distribution_payments SET status = 'failed', adapter_ref = COALESCE(_ref, adapter_ref), failure_reason = left(COALESCE(NULLIF(btrim(_reason), ''), 'The payment failed.'), 500) WHERE id = p.id;
    PERFORM public.distribution_audit(_actor, 'distribution.payment_failed', p.distribution_id, jsonb_build_object('property_id', p.property_id, 'payment_id', p.id, 'holder_key', p.holder_key,
      'amount_cents', p.amount_cents, 'last4', p.bank_last4, 'adapter_ref', _ref, 'reason', _reason));
    RETURN jsonb_build_object('status', 'failed');
  ELSIF _state = 'processing' THEN
    UPDATE public.distribution_payments SET adapter_ref = COALESCE(_ref, adapter_ref) WHERE id = p.id;
    RETURN jsonb_build_object('status', 'processing');
  END IF;
  RAISE EXCEPTION 'Unknown payment result %.', _state USING ERRCODE = 'check_violation';
END;
$$;

-- Where the distribution stands, from its payments. Anything still with the bank keeps it open.
CREATE OR REPLACE FUNCTION public.finalize_distribution(_id uuid, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d public.distribution_events%ROWTYPE;
  c record;
  next_status text;
BEGIN
  IF _actor IS NOT NULL THEN
    PERFORM public.distribution_require_manager(_actor);
  END IF;
  SELECT * INTO d FROM public.distribution_events WHERE id = _id AND workflow = 'payout' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Distribution not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT count(*) FILTER (WHERE status = 'sent') AS sent, count(*) FILTER (WHERE status = 'processing') AS processing, count(*) FILTER (WHERE status IN ('held', 'pending')) AS waiting,
         count(*) FILTER (WHERE status = 'failed') AS failed INTO c FROM public.distribution_payments WHERE distribution_id = d.id;
  IF d.status NOT IN ('authorized', 'executed', 'failed') OR c.processing > 0 THEN
    RETURN jsonb_build_object('status', d.status, 'sent', c.sent, 'processing', c.processing, 'waiting', c.waiting, 'failed', c.failed);
  END IF;
  next_status := d.status;
  IF c.sent > 0 THEN
    next_status := 'executed';
  ELSIF c.waiting = 0 AND c.failed > 0 THEN
    next_status := 'failed';
  ELSIF d.status = 'failed' THEN
    next_status := 'authorized';
  END IF;
  IF next_status <> d.status THEN
    UPDATE public.distribution_events SET status = next_status,
      executed_at = CASE WHEN next_status = 'executed' THEN COALESCE(executed_at, now()) ELSE executed_at END,
      failed_at = CASE WHEN next_status = 'failed' THEN now() ELSE failed_at END,
      failure_reason = CASE WHEN next_status = 'failed' THEN 'Every payment failed. Nothing was posted.' ELSE failure_reason END
    WHERE id = d.id;
    PERFORM public.distribution_audit(_actor, 'distribution.' || next_status, d.id, jsonb_build_object('property_id', d.property_id, 'sent', c.sent, 'waiting', c.waiting, 'failed', c.failed,
      'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  END IF;
  RETURN jsonb_build_object('status', next_status, 'sent', c.sent, 'processing', c.processing, 'waiting', c.waiting, 'failed', c.failed);
END;
$$;

-- Put a failed payment back in the queue (Manager). It is sent again by the next execution call.
CREATE OR REPLACE FUNCTION public.retry_failed_payment(_payment uuid, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p public.distribution_payments%ROWTYPE;
BEGIN
  PERFORM public.distribution_require_manager(_actor);
  SELECT * INTO p FROM public.distribution_payments WHERE id = _payment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF p.status <> 'failed' THEN
    RETURN jsonb_build_object('status', 'not_failed', 'current', p.status);
  END IF;
  UPDATE public.distribution_payments SET status = 'pending', failure_reason = NULL WHERE id = p.id;
  UPDATE public.distribution_events SET status = 'authorized' WHERE id = p.distribution_id AND status = 'failed';
  PERFORM public.distribution_audit(_actor, 'distribution.payment_retry', p.distribution_id, jsonb_build_object('property_id', p.property_id, 'payment_id', p.id, 'holder_key', p.holder_key,
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('status', 'pending');
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 6. Void: the entries that were posted are reversed, nothing is deleted
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_distribution(_id uuid, _reason text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d public.distribution_events%ROWTYPE;
  p public.distribution_payments%ROWTYPE;
  reversed integer := 0;
BEGIN
  PERFORM public.distribution_require_manager(_actor);
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'Say why it is being voided.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO d FROM public.distribution_events WHERE id = _id AND workflow = 'payout' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Distribution not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF d.status = 'voided' THEN
    RETURN jsonb_build_object('status', 'already_voided');
  END IF;
  IF EXISTS (SELECT 1 FROM public.distribution_payments WHERE distribution_id = d.id AND status = 'processing') THEN
    RAISE EXCEPTION 'A payment is still with the bank. Wait for it to settle, then void.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.distribution_payments WHERE distribution_id = d.id AND status = 'sent') AND NOT public.ledger_is_open(d.property_id) THEN
    RAISE EXCEPTION 'The books for this property are not open.' USING ERRCODE = 'check_violation';
  END IF;
  FOR p IN SELECT * FROM public.distribution_payments WHERE distribution_id = d.id ORDER BY holder_key FOR UPDATE LOOP
    IF p.status = 'sent' AND p.entry_id IS NOT NULL AND p.reversed_at IS NULL THEN
      PERFORM public.reverse_entry(p.entry_id, 'The distribution was voided: ' || btrim(_reason), jsonb_build_object('created_by', _actor, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
      UPDATE public.distribution_payments SET reversed_at = now() WHERE id = p.id;
      reversed := reversed + 1;
    ELSIF p.status IN ('pending', 'held', 'failed') THEN
      UPDATE public.distribution_payments SET status = 'cancelled' WHERE id = p.id;
    END IF;
  END LOOP;
  UPDATE public.distribution_events SET status = 'voided', voided_at = now(), voided_by = _actor, void_reason = left(btrim(_reason), 1000) WHERE id = d.id;
  PERFORM public.distribution_audit(_actor, 'distribution.voided', d.id, jsonb_build_object('property_id', d.property_id, 'was', d.status, 'entries_reversed', reversed, 'reason', btrim(_reason),
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('status', 'voided', 'entries_reversed', reversed);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 7. A member's payout method (created by the member; token and last four only)
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_payout_method(_holder_key text, _token text, _last4 text, _bank_name text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_id uuid;
BEGIN
  -- The holder is the person asking: their own buyer account, or themselves as a retained seller.
  IF _actor IS NULL OR NOT (
       (_holder_key = 'seller:' || _actor::text)
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id::text = _holder_key AND b.auth_user_id = _actor)) THEN
    RAISE EXCEPTION 'You can only set your own payout method.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.member_payout_methods SET status = 'removed', removed_at = now() WHERE holder_key = _holder_key AND status = 'active';
  INSERT INTO public.member_payout_methods (holder_key, created_by, bank_name, token, last4) VALUES (_holder_key, _actor, NULLIF(btrim(_bank_name), ''), _token, _last4) RETURNING id INTO new_id;
  PERFORM public.distribution_audit(_actor, 'distribution.payout_method_saved', new_id, jsonb_build_object('holder_key', _holder_key, 'last4', _last4, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_payout_method(_holder_key text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m uuid;
BEGIN
  IF _actor IS NULL OR NOT (
       (_holder_key = 'seller:' || _actor::text)
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id::text = _holder_key AND b.auth_user_id = _actor)) THEN
    RAISE EXCEPTION 'You can only change your own payout method.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.member_payout_methods SET status = 'removed', removed_at = now() WHERE holder_key = _holder_key AND status = 'active' RETURNING id INTO m;
  IF m IS NOT NULL THEN
    PERFORM public.distribution_audit(_actor, 'distribution.payout_method_removed', m, jsonb_build_object('holder_key', _holder_key, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 8. Access
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE public.distribution_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_payout_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distribution_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.distribution_payments, public.member_payout_methods, public.distribution_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.distribution_payments, public.member_payout_methods, public.distribution_settings TO service_role;
GRANT SELECT ON public.distribution_payments TO authenticated;
GRANT SELECT ON public.distribution_settings TO authenticated;

DROP POLICY IF EXISTS "managers and the payee read payments" ON public.distribution_payments;
CREATE POLICY "managers and the payee read payments" ON public.distribution_payments FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin')
    OR (public.is_property_owner(auth.uid(), property_id)
        AND (holder_key = 'seller:' || auth.uid()::text OR holder_key IN (SELECT b.id::text FROM public.buyer_accounts b WHERE b.auth_user_id = auth.uid()))));
DROP POLICY IF EXISTS "managers read the reserve" ON public.distribution_settings;
CREATE POLICY "managers read the reserve" ON public.distribution_settings FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Owners see a distribution once the Manager has authorized it, never a draft.
DROP POLICY IF EXISTS "owners read their property's distributions" ON public.distribution_events;
CREATE POLICY "owners read their property's distributions" ON public.distribution_events
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR (public.is_property_owner(auth.uid(), property_id) AND status <> 'draft'));

REVOKE ALL ON FUNCTION public.default_minimum_reserve_cents(), public.minimum_reserve_cents(uuid), public.distribution_audit(uuid, text, uuid, jsonb), public.distribution_require_manager(uuid),
  public.ledger_period_is_open(uuid, date), public.distributable_cash(uuid, uuid), public.set_minimum_reserve(uuid, bigint, uuid, jsonb),
  public.create_distribution(uuid, bigint, date, text, text, jsonb, jsonb, uuid, jsonb, uuid), public.authorize_distribution(uuid, text, uuid, jsonb),
  public.claim_distribution_payments(uuid, uuid, jsonb, text), public.record_payment_result(uuid, text, text, text, uuid, jsonb), public.finalize_distribution(uuid, uuid, jsonb),
  public.retry_failed_payment(uuid, uuid, jsonb), public.void_distribution(uuid, text, uuid, jsonb), public.save_payout_method(text, text, text, text, uuid, jsonb),
  public.remove_payout_method(text, uuid, jsonb), public.distribution_payments_guard(), public.distribution_events_keep_history(), public.distribution_status_to_ledger()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.default_minimum_reserve_cents(), public.minimum_reserve_cents(uuid), public.distributable_cash(uuid, uuid), public.ledger_period_is_open(uuid, date), public.set_minimum_reserve(uuid, bigint, uuid, jsonb),
  public.create_distribution(uuid, bigint, date, text, text, jsonb, jsonb, uuid, jsonb, uuid), public.authorize_distribution(uuid, text, uuid, jsonb),
  public.claim_distribution_payments(uuid, uuid, jsonb, text), public.record_payment_result(uuid, text, text, text, uuid, jsonb), public.finalize_distribution(uuid, uuid, jsonb),
  public.retry_failed_payment(uuid, uuid, jsonb), public.void_distribution(uuid, text, uuid, jsonb), public.save_payout_method(text, text, text, text, uuid, jsonb),
  public.remove_payout_method(text, uuid, jsonb) TO service_role;
