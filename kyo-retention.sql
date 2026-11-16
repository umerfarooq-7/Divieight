-- Know Your Owner retention (Month 6). Run in the Supabase SQL editor AFTER member-steps.sql, eligibility-declarations.sql, eligibility-results.sql, member-liveness.sql,
-- kyo-corrections.sql and (recommended) audit-vault.sql. Safe to run again.
--
-- ASSUMPTION (flagged on the launch readiness page): the retention periods and this wording are pending compliance review.
--
--   * kyo_retention: one row per KYO record (an Account Member, or a seller) with its retention_class, archived_at and retain_until.
--       active_property  the person is tied to an LLC: kept for the life of the LLC plus 7 years after dissolution (retain_until stays empty until it dissolves)
--       archived         the account ended (not eligible, withdrawn, rejected, abandoned, member removed, login deleted): kept 7 years from archived_at
--       in_use           not ended and not tied to a property: no clock yet
--     A record is never deleted. Past its retention it goes to a review queue; only a founder approving, with a reason, anonymizes it (retention_erase below),
--     never while a legal hold is on it, and the erasure is logged in the Audit Vault without the erased data.
--   * kyo_retention_items: the PII sub-vault items that belong to a KYO record, each with the same class and dates.
--   * retention_reviews: the Retention review queue for compliance.
--   * kyo_deletion_requests: a member's request to have their data deleted, and how it was decided. A request inside the retention period is declined, with the
--     reason recorded.
--   * entity_genesis.llc_dissolved_at: set when an LLC dissolves (recorded by the founder); it starts the 7 years for everyone tied to that LLC.

-- ---------------------------------------------------------------------------------------------------------
-- Columns on existing tables
-- ---------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.entity_genesis') IS NOT NULL THEN
    ALTER TABLE public.entity_genesis ADD COLUMN IF NOT EXISTS llc_dissolved_at date;
  END IF;
  -- An account that ends moves to 'archived' with archived_at and the reason.
  IF to_regclass('public.buyer_accounts') IS NOT NULL THEN
    ALTER TABLE public.buyer_accounts ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS archive_reason text;
  END IF;
  IF to_regclass('public.sellers') IS NOT NULL THEN
    ALTER TABLE public.sellers ADD COLUMN IF NOT EXISTS archived_at timestamptz, ADD COLUMN IF NOT EXISTS archive_reason text;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- The retention ledger
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kyo_retention (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind text NOT NULL CHECK (subject_kind IN ('account_member', 'seller')),
  subject_id uuid NOT NULL,
  buyer_account_id uuid,
  -- The LLCs this record is tied to (the property ids), so the admin view can count by property.
  property_ids uuid[] NOT NULL DEFAULT '{}',
  retention_class text NOT NULL CHECK (retention_class IN ('in_use', 'active_property', 'archived')),
  archive_reason text CHECK (archive_reason IS NULL OR archive_reason IN ('not_eligible', 'withdrawn', 'rejected', 'abandoned', 'member_removed', 'login_deleted')),
  archived_at timestamptz,
  -- Empty while the LLC is alive (the period has not started): never guessed.
  retain_until date,
  retention_basis text,
  status text NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use', 'retained', 'past_retention', 'erased')),
  legal_hold boolean NOT NULL DEFAULT false,
  legal_hold_reason text,
  legal_hold_set_by uuid,
  legal_hold_set_at timestamptz,
  -- After a founder decides to keep a record past its period, the next review is a year on.
  next_review_at date,
  computed_at timestamptz NOT NULL DEFAULT now(),
  erased_at timestamptz,
  erased_by uuid,
  erasure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_kind, subject_id),
  CONSTRAINT kyo_retention_archived_shape CHECK ((retention_class = 'archived') = (archived_at IS NOT NULL) AND (retention_class <> 'archived' OR archive_reason IS NOT NULL)),
  CONSTRAINT kyo_retention_hold_shape CHECK (legal_hold = (legal_hold_reason IS NOT NULL)),
  CONSTRAINT kyo_retention_erased_shape CHECK ((status = 'erased') = (erased_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS kyo_retention_status_idx ON public.kyo_retention (status, retain_until);
CREATE INDEX IF NOT EXISTS kyo_retention_account_idx ON public.kyo_retention (buyer_account_id);

CREATE OR REPLACE FUNCTION public.kyo_retention_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A retention record is never deleted: it is anonymized, with a founder''s approval, after its period.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'erased' AND (to_jsonb(NEW) - 'computed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'computed_at') THEN
    RAISE EXCEPTION 'An erased record is fixed.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.subject_kind <> OLD.subject_kind OR NEW.subject_id <> OLD.subject_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Which record this is cannot change.' USING ERRCODE = 'check_violation';
  END IF;
  -- Erasing is only ever done by retention_erase() (it sets this switch for its own transaction).
  IF NEW.status = 'erased' AND OLD.status <> 'erased' AND current_setting('retention.erasing', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'A record is erased only through retention_erase(), with a founder''s approval.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS kyo_retention_history ON public.kyo_retention;
CREATE TRIGGER kyo_retention_history BEFORE UPDATE OR DELETE ON public.kyo_retention FOR EACH ROW EXECUTE FUNCTION public.kyo_retention_guard();

CREATE TABLE IF NOT EXISTS public.kyo_retention_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retention_id uuid NOT NULL REFERENCES public.kyo_retention(id),
  item_kind text NOT NULL,
  item_table text NOT NULL,
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  retention_class text NOT NULL,
  archived_at timestamptz,
  retain_until date,
  erased_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (retention_id, item_kind)
);
CREATE OR REPLACE FUNCTION public.kyo_retention_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A retention item is never deleted.' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.erased_at IS NOT NULL AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'An erased item is fixed.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS kyo_retention_items_history ON public.kyo_retention_items;
CREATE TRIGGER kyo_retention_items_history BEFORE UPDATE OR DELETE ON public.kyo_retention_items FOR EACH ROW EXECUTE FUNCTION public.kyo_retention_items_guard();

-- ---------------------------------------------------------------------------------------------------------
-- The Retention review queue, and members' deletion requests
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retention_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retention_id uuid NOT NULL REFERENCES public.kyo_retention(id),
  kind text NOT NULL CHECK (kind IN ('past_retention', 'deletion_request')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'erased', 'declined')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  CONSTRAINT retention_reviews_decided_shape CHECK ((status = 'open') = (decided_at IS NULL) AND (status = 'open' OR length(btrim(coalesce(decision_reason, ''))) >= 10))
);
-- One open past-retention review per record, however often the nightly job runs.
CREATE UNIQUE INDEX IF NOT EXISTS retention_reviews_one_open ON public.retention_reviews (retention_id, kind) WHERE status = 'open';
CREATE OR REPLACE FUNCTION public.retention_reviews_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A review is never deleted.' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'A decided review is fixed.' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.retention_id <> OLD.retention_id OR NEW.kind <> OLD.kind OR NEW.opened_at <> OLD.opened_at THEN RAISE EXCEPTION 'A review is only decided, never edited.' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS retention_reviews_history ON public.retention_reviews;
CREATE TRIGGER retention_reviews_history BEFORE UPDATE OR DELETE ON public.retention_reviews FOR EACH ROW EXECUTE FUNCTION public.retention_reviews_guard();

CREATE TABLE IF NOT EXISTS public.kyo_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retention_id uuid NOT NULL REFERENCES public.kyo_retention(id),
  account_member_id uuid NOT NULL,
  buyer_account_id uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- What the member said (kept off the Audit Vault: it may be personal).
  member_note text CHECK (member_note IS NULL OR length(member_note) <= 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'declined', 'approved')),
  -- Why it was decided as it was, and what the record's retention looked like at that moment.
  decision_code text CHECK (decision_code IS NULL OR decision_code IN ('inside_retention', 'legal_hold', 'account_active', 'founder_declined', 'founder_approved')),
  decision_reason text,
  decided_by uuid,
  decided_at timestamptz,
  retention_snapshot jsonb,
  ip text,
  user_agent text,
  CONSTRAINT kyo_deletion_decided_shape CHECK ((status = 'open') = (decided_at IS NULL) AND (status = 'open' OR length(btrim(coalesce(decision_reason, ''))) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS kyo_deletion_one_open ON public.kyo_deletion_requests (account_member_id) WHERE status = 'open';
CREATE OR REPLACE FUNCTION public.kyo_deletion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A deletion request is never deleted.' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.status <> 'open' THEN RAISE EXCEPTION 'A decided request is fixed.' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.retention_id <> OLD.retention_id OR NEW.account_member_id <> OLD.account_member_id OR NEW.requested_at <> OLD.requested_at THEN RAISE EXCEPTION 'A request is only decided, never edited.' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS kyo_deletion_history ON public.kyo_deletion_requests;
CREATE TRIGGER kyo_deletion_history BEFORE UPDATE OR DELETE ON public.kyo_deletion_requests FOR EACH ROW EXECUTE FUNCTION public.kyo_deletion_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Anonymization: the only way a KYO record's personal data is ever removed
-- ---------------------------------------------------------------------------------------------------------
-- Sets the listed columns of one subject's rows in one table, skipping any table or column that does not exist. The record-keeping triggers on these tables
-- (they refuse edits) are switched off for this statement and back on straight after, inside the same transaction.
CREATE OR REPLACE FUNCTION public.retention_anonymize(_table text, _key_col text, _key uuid, _assign jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k text; v jsonb; sets text := ''; n integer := 0;
BEGIN
  IF to_regclass('public.' || _table) IS NULL THEN RETURN 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = _table AND column_name = _key_col) THEN RETURN 0; END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(_assign) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = _table AND column_name = k) THEN
      sets := sets || CASE WHEN sets = '' THEN '' ELSE ', ' END || format('%I = %s', k, CASE WHEN jsonb_typeof(v) = 'null' THEN 'NULL' WHEN jsonb_typeof(v) = 'boolean' THEN v #>> '{}' ELSE quote_literal(v #>> '{}') END);
    END IF;
  END LOOP;
  IF sets = '' THEN RETURN 0; END IF;
  EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', _table);
  EXECUTE format('UPDATE public.%I SET %s WHERE %I = $1', _table, sets, _key_col) USING _key;
  GET DIAGNOSTICS n = ROW_COUNT;
  EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', _table);
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.retention_remove_rows(_table text, _key_col text, _key uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0;
BEGIN
  IF to_regclass('public.' || _table) IS NULL THEN RETURN 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = _table AND column_name = _key_col) THEN RETURN 0; END IF;
  EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', _table);
  EXECUTE format('DELETE FROM public.%I WHERE %I = $1', _table, _key_col) USING _key;
  GET DIAGNOSTICS n = ROW_COUNT;
  EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', _table);
  RETURN n;
END;
$$;

-- Anonymizes one KYO record's personal data. Never called by a job: only by the application when a founder has approved, with a reason.
-- It refuses (and says why, and logs it) for a record under a legal hold, a record still inside its retention period, and a record with no approved review.
-- The erasure is written to the Audit Vault with the counts and the record's id and dates: never the erased data.
CREATE OR REPLACE FUNCTION public.retention_erase(_retention uuid, _founder uuid, _review uuid, _reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.kyo_retention; rev public.retention_reviews; why text := btrim(COALESCE(_reason, '')); counts jsonb := '{}'::jsonb; n integer; sentinel text := '[erased]';
BEGIN
  IF length(why) < 10 THEN RETURN jsonb_build_object('ok', false, 'reason', 'reason_required'); END IF;
  IF _founder IS NULL OR NOT public.has_role(_founder, 'founder') THEN RETURN jsonb_build_object('ok', false, 'reason', 'founder_only'); END IF;
  SELECT * INTO r FROM public.kyo_retention WHERE id = _retention FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF r.status = 'erased' THEN RETURN jsonb_build_object('ok', true, 'already', true); END IF;
  IF r.legal_hold THEN
    INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
    VALUES (_founder, 'admin', 'retention.erasure_blocked_legal_hold', 'kyo_retention', r.id::text, jsonb_build_object('retention_id', r.id, 'retention_class', r.retention_class, 'review_id', _review));
    RETURN jsonb_build_object('ok', false, 'reason', 'legal_hold');
  END IF;
  IF r.retain_until IS NULL OR r.retain_until >= current_date THEN
    INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
    VALUES (_founder, 'admin', 'retention.erasure_blocked_inside_retention', 'kyo_retention', r.id::text, jsonb_build_object('retention_id', r.id, 'retention_class', r.retention_class, 'retain_until', r.retain_until, 'review_id', _review));
    RETURN jsonb_build_object('ok', false, 'reason', 'inside_retention', 'retain_until', r.retain_until);
  END IF;
  SELECT * INTO rev FROM public.retention_reviews WHERE id = _review AND retention_id = r.id FOR UPDATE;
  IF NOT FOUND OR rev.status <> 'open' THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_open_review'); END IF;

  IF r.subject_kind = 'account_member' THEN
    n := public.retention_remove_rows('member_w9_tin_secrets', 'account_member_id', r.subject_id); counts := counts || jsonb_build_object('w9_encrypted_values', n);
    n := public.retention_anonymize('member_w9', 'account_member_id', r.subject_id, jsonb_build_object('legal_name', sentinel, 'address', sentinel, 'signed_name', sentinel, 'tin_last4', '0000', 'ip', null, 'user_agent', null)); counts := counts || jsonb_build_object('member_w9', n);
    n := public.retention_anonymize('eligibility_declarations', 'account_member_id', r.subject_id, jsonb_build_object('answers', null, 'signed_name', null, 'ip', null, 'user_agent', null, 'attested_personally', false, 'status', 'legacy')); counts := counts || jsonb_build_object('eligibility_declarations', n);
    n := public.retention_anonymize('member_liveness_checks', 'account_member_id', r.subject_id, jsonb_build_object('id_document_ref', sentinel, 'selfie_url', sentinel)); counts := counts || jsonb_build_object('member_liveness_checks', n);
    n := public.retention_anonymize('member_sanctions_screenings', 'account_member_id', r.subject_id, jsonb_build_object('matched_name', null)); counts := counts || jsonb_build_object('member_sanctions_screenings', n);
    n := public.retention_anonymize('kyo_correction_requests', 'account_member_id', r.subject_id, jsonb_build_object('requested_change', sentinel, 'ip', null, 'user_agent', null)); counts := counts || jsonb_build_object('kyo_correction_requests', n);
    n := public.retention_anonymize('member_plaid_consents', 'account_member_id', r.subject_id, jsonb_build_object('ip', null, 'user_agent', null)); counts := counts || jsonb_build_object('member_plaid_consents', n);
    n := public.retention_anonymize('member_block2_authorizations', 'account_member_id', r.subject_id, jsonb_build_object('ip', null, 'user_agent', null)); counts := counts || jsonb_build_object('member_block2_authorizations', n);
    n := public.retention_anonymize('account_members', 'id', r.subject_id, jsonb_build_object('full_name', sentinel, 'date_of_birth', null, 'address', null, 'id_document_number', null, 'id_document_url', null, 'email', null, 'phone', null)); counts := counts || jsonb_build_object('account_members', n);
  ELSE
    n := public.retention_anonymize('seller_eligibility_declarations', 'seller_id', r.subject_id, jsonb_build_object('answers', null, 'signed_name', null, 'ip', null, 'user_agent', null)); counts := counts || jsonb_build_object('seller_eligibility_declarations', n);
    n := public.retention_anonymize('sellers', 'id', r.subject_id, jsonb_build_object('full_name', sentinel, 'email', 'erased-' || r.subject_id::text || '@erased.invalid', 'phone', null, 'address', null, 'date_of_birth', null, 'id_document_url', null)); counts := counts || jsonb_build_object('sellers', n);
  END IF;

  PERFORM set_config('retention.erasing', 'on', true);
  UPDATE public.kyo_retention SET status = 'erased', erased_at = now(), erased_by = _founder, erasure_reason = why, computed_at = now() WHERE id = r.id;
  UPDATE public.kyo_retention_items SET erased_at = now(), updated_at = now() WHERE retention_id = r.id AND erased_at IS NULL;
  UPDATE public.retention_reviews SET status = 'erased', decided_by = _founder, decided_at = now(), decision_reason = why WHERE id = rev.id;
  UPDATE public.kyo_deletion_requests SET status = 'approved', decision_code = 'founder_approved', decision_reason = why, decided_by = _founder, decided_at = now() WHERE retention_id = r.id AND status = 'open';
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_founder, 'admin', 'retention.erased', 'kyo_retention', r.id::text,
    jsonb_build_object('retention_id', r.id, 'subject_kind', r.subject_kind, 'subject_id', r.subject_id, 'retention_class', r.retention_class, 'archived_at', r.archived_at, 'retain_until', r.retain_until,
      'review_id', rev.id, 'review_kind', rev.kind, 'reason', why, 'rows_anonymized_or_removed', counts));
  RETURN jsonb_build_object('ok', true, 'counts', counts);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Who can touch it: the server only
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE public.kyo_retention ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kyo_retention_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kyo_deletion_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kyo_retention, public.kyo_retention_items, public.retention_reviews, public.kyo_deletion_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.kyo_retention, public.kyo_retention_items, public.retention_reviews, public.kyo_deletion_requests TO service_role;
REVOKE ALL ON FUNCTION public.retention_anonymize(text, text, uuid, jsonb), public.retention_remove_rows(text, text, uuid), public.retention_erase(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retention_erase(uuid, uuid, uuid, text) TO service_role;
-- No policy for members or visitors: they have no direct access. Members see their own through the application, which checks who is asking.
