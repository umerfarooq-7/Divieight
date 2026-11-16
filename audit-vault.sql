-- Audit Vault hardening (Month 6): append-only for every role, a tamper-evident hash chain, redaction of sensitive values, a row-level safety net on the
-- critical tables, Suspicious Activity Alerts, read-only access that is itself logged.
-- Run in the Supabase SQL editor AFTER audit-roles.sql (which adds the compliance_officer and auditor roles). Safe to run again.
--
-- What this does, in the order it happens:
--   1. audit_log gets who/where columns (acting_member_id, ip_address, user_agent, route, source) and the chain columns (seq, prev_hash, row_hash).
--   2. Every new row is, inside the database and whatever wrote it: redacted (TINs, bank numbers, declaration answers, secrets never reach the log), stamped
--      with the UTC time to the millisecond, numbered, and hashed together with the previous row's hash.
--   3. Rows that already exist are chained once, in the order they were written, before the lock goes on.
--   4. UPDATE, DELETE and TRUNCATE are refused for everyone, by privilege AND by trigger (so also for admin and the service role the app uses).
--   5. audit_verify_chain() recomputes the whole chain; record_audit_checkpoint() stores the result. The nightly job calls it and alerts on a break.
--   6. audit_row_change() records every change to the critical tables whatever code made it (the safety net for any path the app does not log). On the
--      PROTECTED tables (commission, referral and ownership data, the cap table) a change made directly in the database raises a Suspicious Activity Alert.
--   7. read_audit_vault() is the way to read the log: only admin, compliance_officer and auditor, and every read is itself a log row. There is no direct
--      SELECT for members at all.
--
-- A database superuser can still disable a trigger. That cannot be closed from inside the database: see docs/soc2-readiness.md (residual risk).

-- ---------------------------------------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS seq bigint,
  ADD COLUMN IF NOT EXISTS prev_hash text,
  ADD COLUMN IF NOT EXISTS row_hash text,
  ADD COLUMN IF NOT EXISTS acting_member_id uuid,
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS route text,
  ADD COLUMN IF NOT EXISTS source text;

-- ---------------------------------------------------------------------------------------------------------
-- 2. Redaction and canonical form
-- ---------------------------------------------------------------------------------------------------------
-- Keys that name a secret or a sensitive identifier. A key that merely describes one (its last four digits, its kind, whether it is present, a hash of it) is kept.
CREATE OR REPLACE FUNCTION public.audit_key_is_sensitive(k text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT k ~* '(^|_)(tin|ssn|ein|itin|password|passcode|secret|token|ciphertext|auth_tag|iv|answers?|declaration_answers|account_number|routing_number|bank_account|card_number|cvv|date_of_birth|dob)($|_)'
     AND k !~* '(last4|last_4|_kind|_type|_present|_hash|_masked|_mask|_status|_version|_method|_id|_ids|_count)$'
$$;

CREATE OR REPLACE FUNCTION public.audit_redact(j jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; v jsonb; out jsonb;
BEGIN
  IF j IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(j) = 'object' THEN
    out := '{}'::jsonb;
    FOR k, v IN SELECT key, value FROM jsonb_each(j) LOOP
      IF public.audit_key_is_sensitive(k) THEN
        out := out || jsonb_build_object(k, '[redacted]');
      ELSE
        out := out || jsonb_build_object(k, public.audit_redact(v));
      END IF;
    END LOOP;
    RETURN out;
  ELSIF jsonb_typeof(j) = 'array' THEN
    RETURN COALESCE((SELECT jsonb_agg(public.audit_redact(e) ORDER BY ord) FROM jsonb_array_elements(j) WITH ORDINALITY t(e, ord)), '[]'::jsonb);
  ELSIF jsonb_typeof(j) = 'string' AND (j #>> '{}') ~ '^[0-9]{3}-[0-9]{2}-[0-9]{4}$|^[0-9]{2}-[0-9]{7}$' THEN
    RETURN '"[redacted]"'::jsonb; -- a value shaped like an SSN or an EIN, whatever its key
  END IF;
  RETURN j;
END;
$$;

-- Sorted keys, no spaces: the same text however the JSON was written. The hash is taken over this.
CREATE OR REPLACE FUNCTION public.audit_canonical_json(j jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF j IS NULL THEN RETURN 'null'; END IF;
  IF jsonb_typeof(j) = 'object' THEN
    RETURN '{' || COALESCE((SELECT string_agg(to_json(k)::text || ':' || public.audit_canonical_json(j -> k), ',' ORDER BY k COLLATE "C") FROM jsonb_object_keys(j) k), '') || '}';
  ELSIF jsonb_typeof(j) = 'array' THEN
    RETURN '[' || COALESCE((SELECT string_agg(public.audit_canonical_json(e), ',' ORDER BY ord) FROM jsonb_array_elements(j) WITH ORDINALITY t(e, ord)), '') || ']';
  END IF;
  RETURN j::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_row_hash(r public.audit_log)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    r.seq::text,
    r.id::text,
    COALESCE(r.actor_id::text, ''),
    COALESCE(r.actor_type, ''),
    COALESCE(r.acting_member_id::text, ''),
    r.action_type,
    COALESCE(r.entity_type, ''),
    COALESCE(r.entity_id, ''),
    public.audit_canonical_json(r.metadata),
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    COALESCE(r.ip_address, ''),
    COALESCE(r.user_agent, ''),
    COALESCE(r.route, ''),
    COALESCE(r.source, ''),
    COALESCE(r.prev_hash, '')
  ), 'UTF8')), 'hex')
$$;

-- Who is asking, as the API says it (the role and the user in the request's token). Null when there is no request: a direct database session.
CREATE OR REPLACE FUNCTION public.audit_request_role() RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE r text;
BEGIN
  r := NULLIF(current_setting('request.jwt.claim.role', true), '');
  IF r IS NULL THEN
    BEGIN
      r := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
    EXCEPTION WHEN OTHERS THEN r := NULL;
    END;
  END IF;
  RETURN r;
END;
$$;
CREATE OR REPLACE FUNCTION public.audit_request_sub() RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE s text;
BEGIN
  s := NULLIF(current_setting('request.jwt.claim.sub', true), '');
  IF s IS NULL THEN
    BEGIN
      s := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';
    EXCEPTION WHEN OTHERS THEN s := NULL;
    END;
  END IF;
  RETURN CASE WHEN s ~ '^[0-9a-fA-F-]{36}$' THEN s ELSE NULL END;
END;
$$;
-- The request's own headers, only for a signed-in person calling the API directly (their address and browser). Never for the app server's calls.
CREATE OR REPLACE FUNCTION public.audit_request_header(h text) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE hdrs jsonb; v text;
BEGIN
  IF public.audit_request_role() IS DISTINCT FROM 'authenticated' THEN RETURN NULL; END IF;
  BEGIN
    hdrs := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN RETURN NULL;
  END;
  v := hdrs ->> h;
  IF h = 'x-forwarded-for' AND v IS NOT NULL THEN v := btrim(split_part(v, ',', 1)); END IF;
  RETURN left(v, 500);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. The row trigger: redact, lift who/where, stamp, number, chain
-- ---------------------------------------------------------------------------------------------------------
-- SECURITY DEFINER: a signed-in person who logs their own action cannot read the table, but the chain must be able to see the last row.
CREATE OR REPLACE FUNCTION public.audit_log_chain()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE last_seq bigint; last_hash text; m text;
BEGIN
  -- One writer at a time, so the chain has one order.
  PERFORM pg_advisory_xact_lock(7305006041);
  NEW.metadata := public.audit_redact(COALESCE(NEW.metadata, '{}'::jsonb));
  NEW.actor_type := COALESCE(NULLIF(NEW.actor_type, ''), 'system');
  m := COALESCE(NEW.metadata ->> 'acting_member_id', NEW.metadata ->> 'acted_by_member_id');
  IF NEW.acting_member_id IS NULL AND m ~ '^[0-9a-fA-F-]{36}$' THEN NEW.acting_member_id := m::uuid; END IF;
  NEW.ip_address := left(COALESCE(NEW.ip_address, NEW.metadata ->> 'ip_address', NEW.metadata ->> 'ip', public.audit_request_header('x-forwarded-for')), 200);
  NEW.user_agent := left(COALESCE(NEW.user_agent, NEW.metadata ->> 'user_agent', public.audit_request_header('user-agent')), 500);
  NEW.route := left(COALESCE(NEW.route, NEW.metadata ->> 'route'), 300);
  NEW.source := COALESCE(NEW.source, 'app');
  -- The time is the database's, in UTC, to the millisecond: a caller cannot back-date a row.
  NEW.created_at := date_trunc('milliseconds', clock_timestamp());
  SELECT seq, row_hash INTO last_seq, last_hash FROM public.audit_log ORDER BY seq DESC NULLS LAST LIMIT 1;
  NEW.seq := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash := COALESCE(last_hash, 'GENESIS');
  NEW.row_hash := public.audit_row_hash(NEW);
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. Chain the rows that already exist (once, before the lock goes on)
-- ---------------------------------------------------------------------------------------------------------
DO $$
DECLARE r public.audit_log; prev text := 'GENESIS'; n bigint := 0; m text; fixed public.audit_log;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.audit_log WHERE seq IS NULL) THEN RETURN; END IF;
  SELECT COALESCE(max(seq), 0), COALESCE((SELECT row_hash FROM public.audit_log WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1), 'GENESIS') INTO n, prev FROM public.audit_log;
  PERFORM set_config('audit.backfill', 'on', true);
  FOR r IN SELECT * FROM public.audit_log WHERE seq IS NULL ORDER BY created_at, id LOOP
    n := n + 1;
    r.metadata := public.audit_redact(COALESCE(r.metadata, '{}'::jsonb));
    m := COALESCE(r.metadata ->> 'acting_member_id', r.metadata ->> 'acted_by_member_id');
    IF r.acting_member_id IS NULL AND m ~ '^[0-9a-fA-F-]{36}$' THEN r.acting_member_id := m::uuid; END IF;
    r.ip_address := left(COALESCE(r.ip_address, r.metadata ->> 'ip_address'), 200);
    r.user_agent := left(COALESCE(r.user_agent, r.metadata ->> 'user_agent'), 500);
    r.route := left(COALESCE(r.route, r.metadata ->> 'route'), 300);
    r.source := COALESCE(r.source, 'legacy');
    r.created_at := date_trunc('milliseconds', r.created_at);
    r.seq := n;
    r.prev_hash := prev;
    r.row_hash := public.audit_row_hash(r);
    UPDATE public.audit_log SET metadata = r.metadata, acting_member_id = r.acting_member_id, ip_address = r.ip_address, user_agent = r.user_agent, route = r.route,
      source = r.source, created_at = r.created_at, seq = r.seq, prev_hash = r.prev_hash, row_hash = r.row_hash WHERE id = r.id;
    prev := r.row_hash;
  END LOOP;
END;
$$;

ALTER TABLE public.audit_log ALTER COLUMN seq SET NOT NULL, ALTER COLUMN prev_hash SET NOT NULL, ALTER COLUMN row_hash SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_seq_idx ON public.audit_log (seq);

-- ---------------------------------------------------------------------------------------------------------
-- 5. Append-only for everyone
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_log_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The only exception: the one-time chaining of rows written before the chain existed (a row with no sequence number yet).
  IF TG_OP = 'UPDATE' AND current_setting('audit.backfill', true) = 'on' AND OLD.seq IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'The Audit Vault is append-only: a row is never updated, deleted or truncated.' USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_chain_insert ON public.audit_log;
CREATE TRIGGER audit_log_chain_insert BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.audit_log_chain();
DROP TRIGGER IF EXISTS audit_log_no_change ON public.audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.audit_log_guard();
DROP TRIGGER IF EXISTS audit_log_no_truncate ON public.audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_guard();

REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_log FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT ON public.audit_log TO service_role;

-- Reading: nobody reads the table directly through the API. read_audit_vault() below is the door, and it logs every read.
DROP POLICY IF EXISTS "Authenticated can view audit rows" ON public.audit_log;
REVOKE SELECT ON public.audit_log FROM anon, authenticated;
GRANT SELECT ON public.audit_log TO service_role;

-- ---------------------------------------------------------------------------------------------------------
-- 6. Checks of the chain
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_vault_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verified_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'nightly',
  ok boolean NOT NULL,
  rows_checked bigint NOT NULL,
  last_seq bigint NOT NULL,
  last_hash text NOT NULL,
  first_bad_seq bigint,
  reason text
);
CREATE OR REPLACE FUNCTION public.audit_vault_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is a record: it is never edited or deleted.', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;
DROP TRIGGER IF EXISTS audit_vault_checkpoints_history ON public.audit_vault_checkpoints;
CREATE TRIGGER audit_vault_checkpoints_history BEFORE UPDATE OR DELETE ON public.audit_vault_checkpoints FOR EACH ROW EXECUTE FUNCTION public.audit_vault_record_immutable();

-- Recomputes every row's hash and the link between rows. A changed row, a removed row, a reordered row and a row cut from the end of the log are all found.
CREATE OR REPLACE FUNCTION public.audit_verify_chain()
RETURNS TABLE (ok boolean, rows_checked bigint, last_seq bigint, last_hash text, first_bad_seq bigint, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.audit_log; prev_seq bigint := 0; prev text := 'GENESIS'; n bigint := 0; cp public.audit_vault_checkpoints;
BEGIN
  FOR r IN SELECT * FROM public.audit_log ORDER BY seq LOOP
    n := n + 1;
    IF r.seq <> prev_seq + 1 THEN
      RETURN QUERY SELECT false, n, prev_seq, prev, r.seq, format('Rows are missing: expected number %s, found %s.', prev_seq + 1, r.seq);
      RETURN;
    END IF;
    IF r.prev_hash IS DISTINCT FROM prev THEN
      RETURN QUERY SELECT false, n, prev_seq, prev, r.seq, 'The link to the previous row is broken.';
      RETURN;
    END IF;
    IF public.audit_row_hash(r) IS DISTINCT FROM r.row_hash THEN
      RETURN QUERY SELECT false, n, prev_seq, prev, r.seq, 'This row was changed after it was written.';
      RETURN;
    END IF;
    prev_seq := r.seq;
    prev := r.row_hash;
  END LOOP;
  -- Rows cut from the end leave a chain that is still internally consistent: the last good checkpoint is the witness.
  SELECT * INTO cp FROM public.audit_vault_checkpoints c WHERE c.ok ORDER BY c.last_seq DESC LIMIT 1;
  IF FOUND AND (cp.last_seq > prev_seq OR NOT EXISTS (SELECT 1 FROM public.audit_log a WHERE a.seq = cp.last_seq AND a.row_hash = cp.last_hash)) THEN
    RETURN QUERY SELECT false, n, prev_seq, prev, cp.last_seq, format('Rows were removed from the end of the log, or row %s was replaced: a previous check had seen it.', cp.last_seq);
    RETURN;
  END IF;
  RETURN QUERY SELECT true, n, prev_seq, prev, NULL::bigint, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_audit_checkpoint(_source text DEFAULT 'nightly')
RETURNS public.audit_vault_checkpoints LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v record; row_out public.audit_vault_checkpoints;
BEGIN
  SELECT * INTO v FROM public.audit_verify_chain();
  INSERT INTO public.audit_vault_checkpoints (source, ok, rows_checked, last_seq, last_hash, first_bad_seq, reason)
  VALUES (COALESCE(_source, 'nightly'), v.ok, v.rows_checked, v.last_seq, v.last_hash, v.first_bad_seq, v.reason) RETURNING * INTO row_out;
  RETURN row_out;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 7. Suspicious Activity Alerts
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.suspicious_activity_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('out_of_band_change', 'unreconciled_change', 'tin_decrypt_outside_rules', 'tin_decrypt_burst', 'chain_break')),
  severity text NOT NULL DEFAULT 'high' CHECK (severity IN ('high', 'critical')),
  subject_table text,
  subject_pk text,
  audit_row_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- One alert per event, however often the checks run.
  dedupe_key text NOT NULL UNIQUE,
  detected_at timestamptz NOT NULL DEFAULT now(),
  -- When the Compliance Officer was told (the in-app notice and the email).
  notified_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  acknowledgement_note text
);
CREATE OR REPLACE FUNCTION public.suspicious_alerts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An alert is never deleted.' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.severity <> OLD.severity OR NEW.subject_table IS DISTINCT FROM OLD.subject_table OR NEW.subject_pk IS DISTINCT FROM OLD.subject_pk
     OR NEW.audit_row_id IS DISTINCT FROM OLD.audit_row_id OR NEW.detail <> OLD.detail OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.detected_at <> OLD.detected_at THEN
    RAISE EXCEPTION 'An alert is never edited: only notified and acknowledged.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.notified_at IS NOT NULL AND NEW.notified_at IS DISTINCT FROM OLD.notified_at THEN RAISE EXCEPTION 'The notification time is fixed.' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.acknowledged_at IS NOT NULL AND (NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at OR NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by OR NEW.acknowledgement_note IS DISTINCT FROM OLD.acknowledgement_note) THEN
    RAISE EXCEPTION 'An acknowledgement is fixed.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS suspicious_alerts_history ON public.suspicious_activity_alerts;
CREATE TRIGGER suspicious_alerts_history BEFORE UPDATE OR DELETE ON public.suspicious_activity_alerts FOR EACH ROW EXECUTE FUNCTION public.suspicious_alerts_guard();

-- Every change to a critical table, whatever code made it. The record carries the table, the row, the columns that changed, a hash of the row before and after
-- (sensitive columns are left out of the hash), and, for a few status-like columns, the values. It never carries a TIN, a bank number or an answer.
CREATE OR REPLACE FUNCTION public.audit_strip_sensitive(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; v jsonb; out jsonb := '{}'::jsonb;
BEGIN
  IF j IS NULL THEN RETURN NULL; END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(j) LOOP
    IF NOT public.audit_key_is_sensitive(k) THEN out := out || jsonb_build_object(k, v); END IF;
  END LOOP;
  RETURN out;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  is_protected boolean := COALESCE(TG_ARGV[0], 'false') = 'true';
  pk_col text := COALESCE(NULLIF(TG_ARGV[1], ''), 'id');
  value_cols text[] := string_to_array(COALESCE(TG_ARGV[2], ''), ',');
  noise text[] := ARRAY['updated_at', 'last_activity_at', 'stall_warning_sent_at', 'last_seen_at', 'created_at'];
  o jsonb; n jsonb; changed text[]; col text; before_vals jsonb := '{}'::jsonb; after_vals jsonb := '{}'::jsonb;
  direct boolean; req_role text; sub text; rowid text; audit_id uuid; prop text;
BEGIN
  IF TG_OP = 'INSERT' THEN o := NULL; n := public.audit_strip_sensitive(to_jsonb(NEW));
  ELSIF TG_OP = 'DELETE' THEN o := public.audit_strip_sensitive(to_jsonb(OLD)); n := NULL;
  ELSE o := public.audit_strip_sensitive(to_jsonb(OLD)); n := public.audit_strip_sensitive(to_jsonb(NEW));
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(key ORDER BY key) INTO changed FROM jsonb_each(n) e(key, value) WHERE (o -> key) IS DISTINCT FROM value AND NOT key = ANY (noise);
    IF changed IS NULL THEN RETURN NEW; END IF; -- only bookkeeping changed
  ELSE
    SELECT array_agg(key ORDER BY key) INTO changed FROM jsonb_object_keys(COALESCE(n, o)) key WHERE NOT key = ANY (noise);
  END IF;
  rowid := COALESCE(n ->> pk_col, o ->> pk_col, n ->> 'user_id', o ->> 'user_id');
  prop := COALESCE(n ->> 'property_id', o ->> 'property_id', CASE WHEN TG_TABLE_NAME = 'properties' THEN rowid END);
  FOREACH col IN ARRAY value_cols LOOP
    IF col <> '' THEN
      IF o IS NOT NULL AND o ? col THEN before_vals := before_vals || jsonb_build_object(col, o -> col); END IF;
      IF n IS NOT NULL AND n ? col THEN after_vals := after_vals || jsonb_build_object(col, n -> col); END IF;
    END IF;
  END LOOP;
  req_role := public.audit_request_role();
  sub := public.audit_request_sub();
  -- Through the API the session user is the authenticator. Anything else is someone connected to the database itself (the SQL editor, the table editor, psql).
  direct := session_user NOT IN ('authenticator');
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata, source)
  VALUES (
    sub::uuid,
    CASE WHEN direct THEN 'database' ELSE COALESCE(req_role, 'system') END,
    'db.row_changed',
    TG_TABLE_NAME,
    rowid,
    jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP, 'primary_key', rowid, 'property_id', prop, 'changed_columns', to_jsonb(COALESCE(changed, ARRAY[]::text[])),
      'before_hash', CASE WHEN o IS NULL THEN NULL ELSE encode(sha256(convert_to(public.audit_canonical_json(o), 'UTF8')), 'hex') END,
      'after_hash', CASE WHEN n IS NULL THEN NULL ELSE encode(sha256(convert_to(public.audit_canonical_json(n), 'UTF8')), 'hex') END,
      'before', before_vals, 'after', after_vals, 'db_role', session_user, 'request_role', req_role, 'direct_database_change', direct, 'protected', is_protected),
    'trigger'
  ) RETURNING id INTO audit_id;
  IF is_protected AND direct THEN
    INSERT INTO public.suspicious_activity_alerts (kind, severity, subject_table, subject_pk, audit_row_id, detail, dedupe_key)
    VALUES ('out_of_band_change', 'critical', TG_TABLE_NAME, rowid, audit_id,
      jsonb_build_object('operation', TG_OP, 'changed_columns', to_jsonb(COALESCE(changed, ARRAY[]::text[])), 'db_role', session_user, 'property_id', prop, 'why', 'Changed directly in the database, not through the application'),
      'oob:' || audit_id::text)
    ON CONFLICT (dedupe_key) DO NOTHING;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
EXCEPTION WHEN OTHERS THEN
  -- A fault in the safety net must not take the business write down with it. The chain, the lock and the app's own audit rows are unaffected.
  RAISE WARNING 'audit_row_change on % failed: %', TG_TABLE_NAME, SQLERRM;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Which tables carry the safety net: table | protected | primary key | columns whose values are recorded (status-like, never personal).
DO $$
DECLARE spec text; parts text[]; t text;
BEGIN
  FOREACH spec IN ARRAY ARRAY[
    -- PROTECTED: commission splits, referral shares, ownership percentages and the cap table. A direct change here raises a Suspicious Activity Alert.
    'cap_table_entries|true|id|share_number,holder_type,buyer_account_id,property_id',
    'commission_ledger|true|id|role,gross_cents,premium_to_hla_cents,premium_received_cents,share_number,property_id',
    'settlement_documents|true|id|version,status,property_id',
    'buyer_attribution|true|id|response,agent_id',
    'pending_referral_agreements|true|id|status',
    'allocation_overrides|true|id|property_id',
    -- Registration and onboarding
    'buyer_accounts|false|id|onboarding_status,golden_ticket_issued,liquidity_verified,tethered_resident_agent_id',
    'sellers|false|id|onboarding_status,exit_type,retained_shares',
    'agents|false|id|status,onboarding_status,broker_id,eo_lapsed',
    'brokers|false|id|status,onboarding_status',
    'account_members|false|id|status,role,vetting_status,buyer_account_id',
    'eligibility_declarations|false|id|status,account_member_id',
    'eligibility_results|false|id|result,account_member_id',
    -- Payments, reservations, tethering, the hard lock
    'buyer_enrollment_payments|false|id|status,amount_cents,environment',
    'enrollment_payments|false|id|status,amount_cents,environment',
    'pod_reservations|false|id|status,shares_reserved,property_id,buyer_account_id',
    'property_agent_overrides|false|id|agent_id,property_id,buyer_account_id',
    'properties|false|id|listing_status,hard_locked,listing_price,status,exit_type,retained_shares',
    'pods|false|id|hla_status,governance_status,heavy_lifting_agent_id,property_id',
    -- Authorizations, signatures, earnest money, closing funds, entity genesis, saga, disbursement
    'authorization_requests|false|id|status,property_id',
    'authorization_responses|false|id|decision',
    'signed_documents|false|id|document_type,document_version,status',
    'operating_agreement_signatures|false|id|property_id',
    'member_authority_grants|false|id|status,scope',
    'earnest_money_obligations|false|id|status,amount_cents,property_id',
    'closing_funds_obligations|false|id|status,amount_cents,property_id',
    'entity_genesis|false|id|final_oa_status,property_id',
    'saga_runs|false|id|status',
    'disbursement_checks|false|id|status,property_id',
    -- Governance, resale, money
    'votes|false|id|status,property_id',
    'vote_ballots|false|id|choice',
    'resale_listings|false|id|status,property_id',
    'resale_transactions|false|id|status,property_id',
    'expenses|false|id|status,amount_cents,property_id',
    'capital_calls|false|id|status,property_id',
    'distribution_events|false|id|status,total_cents,property_id',
    'journal_entries|false|id|property_id',
    'monthly_statements|false|id|status,version,property_id',
    'cpa_designations|false|id|status,property_id',
    'tax_vault_grants|false|id|',
    -- Admin overrides and configuration
    'user_roles|false|id|role,user_id',
    'platform_settings|false|key|key',
    'retention_exceptions|false|id|status,property_id',
    'insurance_policies|false|id|status,property_id'
  ] LOOP
    parts := string_to_array(spec, '|');
    t := parts[1];
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'audit_row_change_' || t, t);
      EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.audit_row_change(%L, %L, %L)', 'audit_row_change_' || t, t, parts[2], parts[3], parts[4]);
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 8. Reading the Audit Vault: read-only, and logged
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.read_audit_vault(
  _limit int DEFAULT 200, _before_seq bigint DEFAULT NULL, _action text DEFAULT NULL, _actor uuid DEFAULT NULL, _entity text DEFAULT NULL,
  _from timestamptz DEFAULT NULL, _to timestamptz DEFAULT NULL
)
RETURNS SETOF public.audit_log LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE who uuid := auth.uid(); lim int := LEAST(GREATEST(COALESCE(_limit, 200), 1), 1000);
BEGIN
  IF who IS NULL OR NOT (public.has_role(who, 'admin') OR public.has_role(who, 'compliance_officer') OR public.has_role(who, 'auditor')) THEN
    RAISE EXCEPTION 'Only the Manager, the Compliance Officer and auditors can read the Audit Vault.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The access is itself an entry in the log, written before anything is returned.
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, metadata, source)
  VALUES (who, CASE WHEN public.has_role(who, 'auditor') THEN 'auditor' WHEN public.has_role(who, 'compliance_officer') THEN 'compliance_officer' ELSE 'admin' END,
    'audit.vault_accessed', 'audit_log',
    jsonb_build_object('via', 'read_audit_vault', 'limit', lim, 'filters', jsonb_strip_nulls(jsonb_build_object('before_seq', _before_seq, 'action', _action, 'actor', _actor, 'entity', _entity, 'from', _from, 'to', _to))), 'app');
  RETURN QUERY
    SELECT a.* FROM public.audit_log a
    WHERE (_before_seq IS NULL OR a.seq < _before_seq) AND (_action IS NULL OR a.action_type = _action) AND (_actor IS NULL OR a.actor_id = _actor)
      AND (_entity IS NULL OR a.entity_id = _entity) AND (_from IS NULL OR a.created_at >= _from) AND (_to IS NULL OR a.created_at <= _to)
    ORDER BY a.seq DESC LIMIT lim;
END;
$$;

ALTER TABLE public.audit_vault_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suspicious_activity_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_vault_checkpoints, public.suspicious_activity_alerts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.audit_vault_checkpoints TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.suspicious_activity_alerts TO service_role;
DROP POLICY IF EXISTS "vault readers read checkpoints" ON public.audit_vault_checkpoints;
CREATE POLICY "vault readers read checkpoints" ON public.audit_vault_checkpoints FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'compliance_officer') OR public.has_role(auth.uid(), 'auditor'));
DROP POLICY IF EXISTS "vault readers read alerts" ON public.suspicious_activity_alerts;
CREATE POLICY "vault readers read alerts" ON public.suspicious_activity_alerts FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'compliance_officer') OR public.has_role(auth.uid(), 'auditor'));
GRANT SELECT ON public.audit_vault_checkpoints, public.suspicious_activity_alerts TO authenticated;

REVOKE ALL ON FUNCTION public.read_audit_vault(int, bigint, text, uuid, text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.read_audit_vault(int, bigint, text, uuid, text, timestamptz, timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION public.audit_verify_chain(), public.record_audit_checkpoint(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_verify_chain(), public.record_audit_checkpoint(text) TO service_role;
REVOKE ALL ON FUNCTION public.audit_row_change() FROM PUBLIC, anon, authenticated;

-- A read-only database role for break-glass access by an external auditor given a direct connection. Reads through it are NOT logged by the database
-- (a SELECT cannot fire a trigger): prefer read_audit_vault, and see docs/soc2-readiness.md.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_reader') THEN CREATE ROLE audit_reader NOLOGIN; END IF;
END;
$$;
GRANT USAGE ON SCHEMA public TO audit_reader;
GRANT SELECT ON public.audit_log, public.audit_vault_checkpoints, public.suspicious_activity_alerts TO audit_reader;
