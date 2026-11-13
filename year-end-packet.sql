-- Month 6, Prompt 11: the Year-End CPA Export Packet, per LLC.
-- Run in the Supabase SQL editor AFTER bookkeeping.sql, capital-accounts.sql, capital-events.sql, monthly-statements.sql, resale-completion.sql
-- (cpa_worksheet_flags) and, if you have it, str-treatment.sql (lodging_tax_exposure). Safe to run again.
--
--   * Every number in a packet's ledger sections is built HERE, from the journal: the general ledger (every entry, every line, categorized by
--     account), the trial balance and balance sheet as of December 31, the income statement, and each member's capital roll-forward.
--   * A packet is IMMUTABLE. Each generation is a new version with a hash; nothing is ever edited or deleted. The Audit Vault logs production.
--   * The packet's data here carries NO TIN. The files that carry TINs live in a separate private bucket (the PII Sub-Vault pattern: no client
--     policy, reached only through an admin-checked server function) and are left out of every general download.
--   * The CPA Cooperation Worksheet is flags only: the depreciation entry that is needed (the CPA supplies the schedule), any Section 754
--     question from a resale (flag only, never computed), the lodging-tax exposure (who, never how much), and any other flag.
--   * No K-1, no Form 1065, no tax return, no depreciation and no Section 754 figure is produced anywhere in this file.

-- ---------------------------------------------------------------------------------------------------------
-- 1. The CPA Cooperation Worksheet items
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cpa_worksheet_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  item_type text NOT NULL CHECK (item_type IN ('depreciation_needed', 'section_754_review', 'lodging_tax_exposure', 'other')),
  title text NOT NULL,
  -- What the flag is about. Never an amount the platform worked out.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_key text NOT NULL DEFAULT 'auto',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed')),
  -- The Manager's annotation for the CPA.
  manager_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, year, item_type, source_key)
);

CREATE OR REPLACE FUNCTION public.packet_audit(_actor uuid, _action text, _id uuid, _meta jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, CASE WHEN _actor IS NULL THEN 'system' ELSE 'admin' END, _action, 'year_end_packet', _id::text,
          _meta || jsonb_build_object('at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
END;
$$;

CREATE OR REPLACE FUNCTION public.packet_require_manager(_actor uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can do that.' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- Bring the year's worksheet up to date from what the books and Month 5 recorded. Safe to run again: an item is made once, and the Manager's
-- note and status on it are never overwritten. Flags only: nothing is computed.
CREATE OR REPLACE FUNCTION public.refresh_worksheet_items(_property uuid, _year integer, _actor uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  y0 date := make_date(_year, 1, 1);
  y1 date := make_date(_year, 12, 31);
  made integer := 0;
  n integer;
  dep bigint;
  f record;
  lodging jsonb;
BEGIN
  PERFORM public.packet_require_manager(_actor);
  -- 1. The year's depreciation entry. The CPA supplies the schedule; the Manager enters it; the platform never works it out.
  SELECT COALESCE(-sum(amount_cents), 0)::bigint INTO dep FROM public.capital_account_ledger WHERE property_id = _property AND line_type = 'depreciation' AND effective_date BETWEEN y0 AND y1;
  INSERT INTO public.cpa_worksheet_items (property_id, year, item_type, title, detail, source_key)
  VALUES (_property, _year, 'depreciation_needed',
    CASE WHEN dep > 0 THEN 'Depreciation for ' || _year || ' was entered from the CPA''s schedule' ELSE 'Depreciation entry needed for ' || _year || ': the CPA supplies the schedule' END,
    jsonb_build_object('entered', dep > 0, 'entered_cents', CASE WHEN dep > 0 THEN dep END, 'note', 'The platform does not calculate depreciation. The Manager enters the figure from the CPA''s schedule.'), 'auto')
  ON CONFLICT (property_id, year, item_type, source_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  made := made + n;
  -- Already entered since the item was made: say so, without touching the Manager's note.
  UPDATE public.cpa_worksheet_items SET title = 'Depreciation for ' || _year || ' was entered from the CPA''s schedule', updated_at = now(),
         detail = detail || jsonb_build_object('entered', true, 'entered_cents', dep)
   WHERE property_id = _property AND year = _year AND item_type = 'depreciation_needed' AND source_key = 'auto' AND dep > 0 AND COALESCE((detail->>'entered')::boolean, false) = false;
  -- 2. The Month 5 flags: a Section 754 question for each resale, flag only; anything else as 'other'.
  FOR f IN SELECT * FROM public.cpa_worksheet_flags WHERE property_id = _property AND created_at::date BETWEEN y0 AND y1 LOOP
    INSERT INTO public.cpa_worksheet_items (property_id, year, item_type, title, detail, source_key)
    VALUES (_property, _year, CASE WHEN f.flag_type = 'section_754_review' THEN 'section_754_review' ELSE 'other' END,
      CASE WHEN f.flag_type = 'section_754_review' THEN 'Section 754 question: a share changed hands (flag only; the platform never computes basis)' ELSE 'Flagged: ' || replace(f.flag_type, '_', ' ') END,
      jsonb_build_object('flag_id', f.id, 'flag_type', f.flag_type, 'resale_transaction_id', f.resale_transaction_id, 'flagged_on', f.created_at::date, 'note', f.note), f.id::text)
    ON CONFLICT (property_id, year, item_type, source_key) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    made := made + n;
  END LOOP;
  -- 3. The lodging-tax exposure from the owners' STR records: who, never how much.
  IF to_regprocedure('public.lodging_tax_exposure(uuid,uuid)') IS NOT NULL THEN
    EXECUTE 'SELECT public.lodging_tax_exposure($1, $2)' INTO lodging USING _property, _actor;
    IF jsonb_array_length(COALESCE(lodging, '[]'::jsonb)) > 0 THEN
      INSERT INTO public.cpa_worksheet_items (property_id, year, item_type, title, detail, source_key)
      VALUES (_property, _year, 'lodging_tax_exposure', 'State and local lodging-tax exposure: owners with short-term-rental activity (no amounts)', jsonb_build_object('members', lodging), 'auto')
      ON CONFLICT (property_id, year, item_type, source_key) DO UPDATE SET detail = EXCLUDED.detail, updated_at = now() WHERE public.cpa_worksheet_items.detail IS DISTINCT FROM EXCLUDED.detail;
      GET DIAGNOSTICS n = ROW_COUNT;
      made := made + n;
    END IF;
  END IF;
  PERFORM public.packet_audit(_actor, 'packet.worksheet_refreshed', _property, jsonb_build_object('property_id', _property, 'year', _year, 'items_made', made));
  RETURN made;
END;
$$;

-- The Manager's annotation, and marking an item reviewed.
CREATE OR REPLACE FUNCTION public.annotate_worksheet_item(_id uuid, _note text, _status text, _actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.cpa_worksheet_items%ROWTYPE;
BEGIN
  PERFORM public.packet_require_manager(_actor);
  IF _status NOT IN ('open', 'reviewed') THEN
    RAISE EXCEPTION 'An item is open or reviewed.' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.cpa_worksheet_items SET manager_note = NULLIF(btrim(left(COALESCE(_note, ''), 4000)), ''), status = _status, updated_at = now() WHERE id = _id RETURNING * INTO i;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Worksheet item not found' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM public.packet_audit(_actor, 'packet.worksheet_annotated', i.property_id, jsonb_build_object('item_id', _id, 'item_type', i.item_type, 'year', i.year, 'status', _status));
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 2. 1099 copies: the forms the platform issued to LLC vendors (none yet: the platform does not issue 1099s today)
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendor_1099_copies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  tax_year integer NOT NULL,
  vendor_name text NOT NULL,
  form_type text NOT NULL DEFAULT '1099-NEC',
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  file_path text,
  issued_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------------------
-- 3. The packets (immutable) and the PII sub-vault's record
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.year_end_packets (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES public.properties(id),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  version integer NOT NULL CHECK (version >= 1),
  schema_version text NOT NULL,
  -- The whole packet as structured data, with NO TIN in it.
  data jsonb NOT NULL,
  hash text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  -- Who generated it: the Manager's id, or NULL for the scheduled job.
  generated_by uuid,
  generated_at timestamptz NOT NULL DEFAULT now(),
  -- The files made from it: [{name, path, kind, bytes, sha256, pii}]. Set once. A pii file is in the PII sub-vault bucket.
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  has_tins boolean NOT NULL DEFAULT false,
  UNIQUE (property_id, year, version)
);
CREATE INDEX IF NOT EXISTS year_end_packets_property_idx ON public.year_end_packets (property_id, year DESC, version DESC);

CREATE OR REPLACE FUNCTION public.year_end_packets_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A packet is never deleted. A correction is a new version.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.property_id <> OLD.property_id OR NEW.year <> OLD.year OR NEW.version <> OLD.version OR NEW.data IS DISTINCT FROM OLD.data OR NEW.hash <> OLD.hash
     OR NEW.schema_version <> OLD.schema_version OR NEW.trigger <> OLD.trigger OR NEW.generated_by IS DISTINCT FROM OLD.generated_by OR NEW.generated_at <> OLD.generated_at THEN
    RAISE EXCEPTION 'A packet is a snapshot and can''t be edited. A correction is a new version.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.files <> '[]'::jsonb AND (NEW.files IS DISTINCT FROM OLD.files OR NEW.has_tins IS DISTINCT FROM OLD.has_tins) THEN
    RAISE EXCEPTION 'A packet''s files are fixed once they are made.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS year_end_packets_history ON public.year_end_packets;
CREATE TRIGGER year_end_packets_history BEFORE UPDATE OR DELETE ON public.year_end_packets FOR EACH ROW EXECUTE FUNCTION public.year_end_packets_guard();

-- ---------------------------------------------------------------------------------------------------------
-- 4. The ledger sections, from the journal
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.packet_ledger_sections(_property uuid, _year integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  y0 date := make_date(_year, 1, 1);
  y1 date := make_date(_year, 12, 31);
  accounts jsonb;
  entries jsonb;
  tb jsonb;
  bs jsonb;
  inc jsonb;
  alloc jsonb;
  rf jsonb;
  assets jsonb;
  liabilities jsonb;
  equity jsonb;
  unalloc bigint;
  total_assets bigint;
  total_le bigint;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'type', type, 'normal_balance', normal_balance, 'member_control', is_member_control) ORDER BY code), '[]'::jsonb) INTO accounts
  FROM (SELECT DISTINCT ON (a.code) a.code, a.name, a.type, a.normal_balance, a.is_member_control FROM public.coa_accounts a JOIN public.coa_versions v ON v.id = a.version_id ORDER BY a.code, v.version DESC) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', e.id, 'date', e.entry_date, 'source', e.source, 'source_ref', e.source_ref, 'memo', COALESCE(e.memo, ''),
      'reverses_entry_id', e.reverses_entry_id, 'adjustment', COALESCE(e.is_adjustment, false),
      'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object('account_code', a.code, 'account_name', a.name, 'category', a.type, 'member_key', l.member_id, 'debit_cents', l.debit_cents, 'credit_cents', l.credit_cents) ORDER BY a.code, l.member_id NULLS FIRST, l.debit_cents DESC, l.credit_cents DESC, l.id), '[]'::jsonb)
                FROM public.journal_lines l JOIN public.coa_accounts a ON a.id = l.account_id WHERE l.entry_id = e.id)) ORDER BY e.entry_date, e.posted_at, e.memo, e.source, e.id), '[]'::jsonb) INTO entries
  FROM public.journal_entries e WHERE e.property_id = _property AND e.entry_date BETWEEN y0 AND y1;

  -- The trial balance as of December 31: every account, everything posted through that day.
  WITH t AS (
    SELECT a.code, max(a.name) AS name, max(a.type) AS type, max(a.normal_balance) AS nb, COALESCE(sum(l.debit_cents), 0)::bigint AS d, COALESCE(sum(l.credit_cents), 0)::bigint AS c
    FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
    WHERE e.property_id = _property AND e.entry_date <= y1 GROUP BY a.code)
  SELECT jsonb_build_object('as_of', y1,
      'rows', COALESCE(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'type', type, 'debit_cents', d, 'credit_cents', c, 'balance_cents', CASE WHEN nb = 'debit' THEN d - c ELSE c - d END) ORDER BY code), '[]'::jsonb),
      'total_debit_cents', COALESCE(sum(d), 0)::bigint, 'total_credit_cents', COALESCE(sum(c), 0)::bigint, 'balanced', COALESCE(sum(d), 0) = COALESCE(sum(c), 0)) INTO tb FROM t;

  -- The balance sheet as of December 31.
  WITH t AS (
    SELECT a.code, max(a.name) AS name, max(a.type) AS type, COALESCE(sum(l.debit_cents), 0)::bigint AS d, COALESCE(sum(l.credit_cents), 0)::bigint AS c
    FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
    WHERE e.property_id = _property AND e.entry_date <= y1 GROUP BY a.code)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'balance_cents', d - c) ORDER BY code) FILTER (WHERE type = 'asset'), '[]'::jsonb),
         COALESCE(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'balance_cents', c - d) ORDER BY code) FILTER (WHERE type = 'liability'), '[]'::jsonb),
         COALESCE(sum(d - c) FILTER (WHERE type = 'asset'), 0)::bigint,
         COALESCE(sum(c - d) FILTER (WHERE type = 'liability'), 0)::bigint,
         COALESCE(sum(c - d) FILTER (WHERE type IN ('income', 'expense')), 0)::bigint
    INTO assets, liabilities, total_assets, total_le, unalloc FROM t;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('member_key', member_id, 'balance_cents', bal) ORDER BY member_id), '[]'::jsonb), total_le + COALESCE(sum(bal), 0)::bigint + unalloc INTO equity, total_le
  FROM (SELECT l.member_id, sum(l.credit_cents - l.debit_cents)::bigint AS bal
        FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
        WHERE e.property_id = _property AND e.entry_date <= y1 AND a.is_member_control AND l.member_id IS NOT NULL GROUP BY l.member_id) m;
  bs := jsonb_build_object('as_of', y1, 'assets', assets, 'liabilities', liabilities, 'member_capital', equity, 'unallocated_net_income_cents', unalloc,
    'total_assets_cents', total_assets, 'total_liabilities_and_equity_cents', total_le, 'balanced', total_assets = total_le);

  -- The income statement: what the LLC itself earned and spent, before it is passed on to the members, and what was allocated.
  inc := public.statement_llc_activity(_property, y0, y1, true) || jsonb_build_object('year', _year);
  SELECT jsonb_build_object('income_allocated_cents', COALESCE(sum(l.debit_cents - l.credit_cents) FILTER (WHERE a.type = 'income'), 0)::bigint,
                            'expense_allocated_cents', COALESCE(sum(l.credit_cents - l.debit_cents) FILTER (WHERE a.type = 'expense'), 0)::bigint) INTO alloc
  FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
  WHERE e.property_id = _property AND e.entry_date BETWEEN y0 AND y1 AND a.type IN ('income', 'expense')
    AND (COALESCE(e.source_ref, '') LIKE 'allocation-%' OR EXISTS (SELECT 1 FROM public.journal_entries o WHERE o.id = e.reverses_entry_id AND COALESCE(o.source_ref, '') LIKE 'allocation-%'));
  inc := inc || jsonb_build_object('allocated_to_members', alloc);

  -- Each member's capital account roll-forward, and the prior year's ending for the continuity check.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('member_key', c.member_key, 'beginning_cents', c.beginning_cents, 'contributions_cents', c.contributions_cents + c.opening_cents,
      'distributions_cents', c.distributions_cents, 'income_cents', c.income_cents, 'expense_cents', c.expense_cents, 'depreciation_cents', c.depreciation_cents,
      'transfers_cents', c.transfer_in_cents + c.transfer_out_cents, 'ending_cents', c.ending_cents, 'prior_year_ending_cents', COALESCE(p.ending_cents, 0),
      'beginning_matches_prior_ending', c.beginning_cents = COALESCE(p.ending_cents, 0)) ORDER BY c.member_key), '[]'::jsonb) INTO rf
  FROM public.capital_roll_forward(_property, _year) c LEFT JOIN public.capital_roll_forward(_property, _year - 1) p ON p.member_key = c.member_key;

  RETURN jsonb_build_object('accounts', accounts, 'entries', entries, 'trial_balance', tb, 'balance_sheet', bs, 'income_statement', inc, 'roll_forwards', rf);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. Recording a packet
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_year_end_packet(_id uuid, _property uuid, _year integer, _payload jsonb, _trigger text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v integer;
  h text;
BEGIN
  IF _actor IS NOT NULL THEN
    PERFORM public.packet_require_manager(_actor);
  ELSIF _trigger <> 'scheduled' THEN
    RAISE EXCEPTION 'Only the scheduled job generates a packet without the Manager.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF make_date(_year, 12, 31) >= current_date THEN
    RAISE EXCEPTION 'A year-end packet is made after the year has ended.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.ledger_is_open(_property) THEN
    RAISE EXCEPTION 'The books for this LLC are not open.' USING ERRCODE = 'check_violation';
  END IF;
  IF (_payload->>'packet_id')::uuid IS DISTINCT FROM _id THEN
    RAISE EXCEPTION 'The packet''s own id is not the one recorded.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO v FROM public.year_end_packets WHERE property_id = _property AND year = _year;
  h := encode(sha256(convert_to(_payload::text, 'UTF8')), 'hex');
  INSERT INTO public.year_end_packets (id, property_id, year, version, schema_version, data, hash, trigger, generated_by)
  VALUES (_id, _property, _year, v, COALESCE(_payload->>'schema_version', '1.0.0'), _payload, h, _trigger, _actor);
  PERFORM public.packet_audit(_actor, 'packet.generated', _id, jsonb_build_object('property_id', _property, 'year', _year, 'version', v, 'hash', h, 'trigger', _trigger,
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('id', _id, 'version', v, 'hash', h);
END;
$$;

-- The files made from a packet: set once.
CREATE OR REPLACE FUNCTION public.set_packet_files(_id uuid, _files jsonb, _has_tins boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.year_end_packets SET files = _files, has_tins = _has_tins WHERE id = _id AND files = '[]'::jsonb;
END;
$$;

-- A download is logged.
CREATE OR REPLACE FUNCTION public.log_packet_download(_id uuid, _file text, _pii boolean, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.packet_audit(_actor, CASE WHEN _pii THEN 'packet.pii_file_downloaded' ELSE 'packet.downloaded' END, _id, jsonb_build_object('file', _file, 'pii', _pii,
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 6. Reconciliation: a packet against the journal, recomputed from the raw lines
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.packet_reconciliation(_packet uuid)
RETURNS TABLE (check_name text, packet_cents bigint, ledger_cents bigint, ok boolean)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  p public.year_end_packets%ROWTYPE;
  y0 date;
  y1 date;
BEGIN
  SELECT * INTO p FROM public.year_end_packets WHERE id = _packet;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Packet not found' USING ERRCODE = 'no_data_found';
  END IF;
  y0 := make_date(p.year, 1, 1);
  y1 := make_date(p.year, 12, 31);
  RETURN QUERY
  WITH x AS (
    SELECT
      (SELECT COALESCE(sum((l->>'debit_cents')::bigint), 0) FROM jsonb_array_elements(p.data->'entries') e, jsonb_array_elements(e->'lines') l)::bigint AS gl_d,
      (SELECT COALESCE(sum((l->>'credit_cents')::bigint), 0) FROM jsonb_array_elements(p.data->'entries') e, jsonb_array_elements(e->'lines') l)::bigint AS gl_c,
      (SELECT COALESCE(sum(l.debit_cents), 0) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id WHERE e.property_id = p.property_id AND e.entry_date BETWEEN y0 AND y1)::bigint AS j_d,
      (SELECT COALESCE(sum(l.credit_cents), 0) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id WHERE e.property_id = p.property_id AND e.entry_date BETWEEN y0 AND y1)::bigint AS j_c,
      (SELECT COALESCE(sum(l.debit_cents), 0) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id WHERE e.property_id = p.property_id AND e.entry_date <= y1)::bigint AS tb_j_d,
      (SELECT COALESCE(sum(l.credit_cents), 0) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id WHERE e.property_id = p.property_id AND e.entry_date <= y1)::bigint AS tb_j_c,
      (SELECT COALESCE(sum(l.credit_cents - l.debit_cents), 0) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
         WHERE e.property_id = p.property_id AND a.type = 'income' AND e.entry_date BETWEEN y0 AND y1 AND COALESCE(e.source_ref, '') NOT LIKE 'allocation-%'
           AND NOT EXISTS (SELECT 1 FROM public.journal_entries o WHERE o.id = e.reverses_entry_id AND COALESCE(o.source_ref, '') LIKE 'allocation-%'))::bigint AS j_inc,
      (SELECT COALESCE(sum(l.debit_cents - l.credit_cents), 0) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
         WHERE e.property_id = p.property_id AND a.type = 'expense' AND e.entry_date BETWEEN y0 AND y1 AND COALESCE(e.source_ref, '') NOT LIKE 'allocation-%'
           AND NOT EXISTS (SELECT 1 FROM public.journal_entries o WHERE o.id = e.reverses_entry_id AND COALESCE(o.source_ref, '') LIKE 'allocation-%'))::bigint AS j_exp,
      (SELECT COALESCE(sum(l.credit_cents - l.debit_cents), 0) FROM public.journal_lines l JOIN public.journal_entries e ON e.id = l.entry_id JOIN public.coa_accounts a ON a.id = l.account_id
         WHERE e.property_id = p.property_id AND a.is_member_control AND l.member_id IS NOT NULL AND e.entry_date <= y1)::bigint AS j_cap,
      (SELECT COALESCE(sum((r->>'ending_cents')::bigint), 0) FROM jsonb_array_elements(p.data->'roll_forwards') r)::bigint AS p_cap,
      (SELECT count(*) FROM jsonb_array_elements(p.data->'roll_forwards') r WHERE NOT COALESCE((r->>'beginning_matches_prior_ending')::boolean, false))::bigint AS rf_bad)
  SELECT 'general ledger debits'::text, x.gl_d, x.j_d, x.gl_d = x.j_d FROM x
  UNION ALL SELECT 'general ledger credits', x.gl_c, x.j_c, x.gl_c = x.j_c FROM x
  UNION ALL SELECT 'trial balance debits', (p.data->'trial_balance'->>'total_debit_cents')::bigint, x.tb_j_d, (p.data->'trial_balance'->>'total_debit_cents')::bigint = x.tb_j_d FROM x
  UNION ALL SELECT 'trial balance credits', (p.data->'trial_balance'->>'total_credit_cents')::bigint, x.tb_j_c, (p.data->'trial_balance'->>'total_credit_cents')::bigint = x.tb_j_c FROM x
  UNION ALL SELECT 'trial balance balances', (p.data->'trial_balance'->>'total_debit_cents')::bigint, (p.data->'trial_balance'->>'total_credit_cents')::bigint, COALESCE((p.data->'trial_balance'->>'balanced')::boolean, false) FROM x
  UNION ALL SELECT 'balance sheet balances', (p.data->'balance_sheet'->>'total_assets_cents')::bigint, (p.data->'balance_sheet'->>'total_liabilities_and_equity_cents')::bigint, COALESCE((p.data->'balance_sheet'->>'balanced')::boolean, false) FROM x
  UNION ALL SELECT 'income statement income', (p.data->'income_statement'->>'income_cents')::bigint, x.j_inc, (p.data->'income_statement'->>'income_cents')::bigint = x.j_inc FROM x
  UNION ALL SELECT 'income statement expense', (p.data->'income_statement'->>'expense_cents')::bigint, x.j_exp, (p.data->'income_statement'->>'expense_cents')::bigint = x.j_exp FROM x
  UNION ALL SELECT 'members ending capital', x.p_cap, x.j_cap, x.p_cap = x.j_cap FROM x
  UNION ALL SELECT 'roll-forward beginning = prior ending', x.rf_bad, 0::bigint, x.rf_bad = 0 FROM x;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 7. Access: the Manager reads; nobody writes from a login; the two buckets are private
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE public.cpa_worksheet_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_1099_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.year_end_packets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cpa_worksheet_items, public.vendor_1099_copies, public.year_end_packets FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.cpa_worksheet_items, public.vendor_1099_copies, public.year_end_packets TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cpa_worksheet_items, public.year_end_packets TO service_role;
GRANT SELECT, INSERT ON public.vendor_1099_copies TO service_role;
DROP POLICY IF EXISTS "the Manager reads worksheet items" ON public.cpa_worksheet_items;
CREATE POLICY "the Manager reads worksheet items" ON public.cpa_worksheet_items FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS "the Manager reads 1099 copies" ON public.vendor_1099_copies;
CREATE POLICY "the Manager reads 1099 copies" ON public.vendor_1099_copies FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS "the Manager reads packets" ON public.year_end_packets;
CREATE POLICY "the Manager reads packets" ON public.year_end_packets FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- The general bucket and the PII sub-vault: both private, neither with any policy, so only the server (service role) reaches them.
INSERT INTO storage.buckets (id, name, public) VALUES ('year-end-packets', 'year-end-packets', false) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('packet-pii', 'packet-pii', false) ON CONFLICT (id) DO NOTHING;

REVOKE ALL ON FUNCTION public.packet_audit(uuid, text, uuid, jsonb), public.packet_require_manager(uuid), public.refresh_worksheet_items(uuid, integer, uuid), public.annotate_worksheet_item(uuid, text, text, uuid),
  public.year_end_packets_guard(), public.packet_ledger_sections(uuid, integer), public.record_year_end_packet(uuid, uuid, integer, jsonb, text, uuid, jsonb),
  public.set_packet_files(uuid, jsonb, boolean), public.log_packet_download(uuid, text, boolean, uuid, jsonb), public.packet_reconciliation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_worksheet_items(uuid, integer, uuid), public.annotate_worksheet_item(uuid, text, text, uuid), public.packet_ledger_sections(uuid, integer),
  public.record_year_end_packet(uuid, uuid, integer, jsonb, text, uuid, jsonb), public.set_packet_files(uuid, jsonb, boolean), public.log_packet_download(uuid, text, boolean, uuid, jsonb),
  public.packet_reconciliation(uuid) TO service_role;
