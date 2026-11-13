-- Month 6, Prompt 13: the tax-form payment gate and the tax data.
-- Run in the Supabase SQL editor AFTER brokers-tax-form-gate.sql, member-steps.sql, resale-completion.sql, capital-events.sql and
-- year-end-packet.sql. Safe to run again.
--
--   1. BROKER OF RECORD GATE. No payout goes to a Broker of Record until a VALID tax form is on file: a W-9 for a US person or entity, a
--      W-8BEN for a non-US individual, a W-8BEN-E for a non-US entity (the form must match who the broker is). A W-8 expires (the end of the
--      third calendar year after it was signed). The TIN or foreign tax ID is encrypted by the app (the same AES-256-GCM as the members'
--      W-9s) into a table no login can read; only the last four are kept in the clear. The old brokers.tax_form_verified flag (set by the
--      broker's own browser on upload) no longer clears anything: the gate reads broker_tax_forms, and a login can't change the flag.
--   2. INFLUENCERS are paid directly, never through a Broker of Record: payees, payments, an annual summary (total >= $600 is a 1099-NEC
--      payee; a non-US payee on a W-8 gets no 1099-NEC and is flagged for the CPA). The platform records and exports data. It files nothing.
--   3. THE TAX-READY FOLDER, per property per year: the 1099-S data from resales and per-share ownership records reconciled for the CPA's
--      K-1 preparation, immutable and versioned, kept in the PII sub-vault, visible only with the tax-vault permission.
--   4. Who may open the vault: the founder, or someone the founder has granted access (tax_vault_grants). A regular admin can't, without it.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Broker tax forms
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.broker_tax_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id uuid NOT NULL REFERENCES public.brokers(id),
  form_type text NOT NULL CHECK (form_type IN ('W-9', 'W-8BEN', 'W-8BEN-E')),
  is_us_person boolean NOT NULL,
  entity_kind text NOT NULL CHECK (entity_kind IN ('individual', 'entity')),
  -- The form has to be the right one for who the broker is.
  CHECK ((is_us_person AND form_type = 'W-9')
      OR (NOT is_us_person AND entity_kind = 'individual' AND form_type = 'W-8BEN')
      OR (NOT is_us_person AND entity_kind = 'entity' AND form_type = 'W-8BEN-E')),
  legal_name text NOT NULL CHECK (btrim(legal_name) <> ''),
  address text NOT NULL CHECK (btrim(address) <> ''),
  country text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  CHECK (is_us_person = (country = 'US')),
  tin_kind text NOT NULL CHECK (tin_kind IN ('ssn', 'ein', 'itin', 'foreign_tin', 'none')),
  tin_last4 text CHECK (tin_last4 IS NULL OR tin_last4 ~ '^[A-Za-z0-9]{4}$'),
  -- A W-9 needs a US TIN. A W-8 has a foreign tax ID, or none where the country issues none.
  CHECK (form_type <> 'W-9' OR (tin_kind IN ('ssn', 'ein', 'itin') AND tin_last4 IS NOT NULL)),
  CHECK (form_type = 'W-9' OR tin_kind IN ('foreign_tin', 'none', 'itin', 'ssn', 'ein')),
  signed_name text NOT NULL CHECK (btrim(signed_name) <> ''),
  signed_at timestamptz NOT NULL DEFAULT now(),
  -- A W-8 lapses; a W-9 doesn't.
  expiry_date date,
  CHECK ((form_type = 'W-9') = (expiry_date IS NULL)),
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'rejected', 'superseded')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_reason text,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS broker_tax_forms_one_valid ON public.broker_tax_forms (broker_id) WHERE status = 'valid';
CREATE INDEX IF NOT EXISTS broker_tax_forms_broker_idx ON public.broker_tax_forms (broker_id, created_at DESC);

-- The encrypted TIN or foreign tax ID. No policy and no grant for any login.
CREATE TABLE IF NOT EXISTS public.broker_tax_form_secrets (
  form_id uuid PRIMARY KEY REFERENCES public.broker_tax_forms(id),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.tax_audit(_actor uuid, _action text, _entity_type text, _id text, _meta jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, CASE WHEN _actor IS NULL THEN 'system' ELSE 'admin' END, _action, _entity_type, _id,
          _meta || jsonb_build_object('at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
END;
$$;

CREATE OR REPLACE FUNCTION public.tax_require_admin(_actor uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can do that.' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- Where a broker stands: valid, expired, rejected or missing. The one answer the payout gates ask for.
CREATE OR REPLACE FUNCTION public.broker_tax_form_state(_broker uuid, _on date DEFAULT current_date)
RETURNS TABLE (state text, form_id uuid, form_type text, expiry_date date)
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE f public.broker_tax_forms%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.broker_tax_forms WHERE broker_id = _broker AND status = 'valid';
  IF FOUND THEN
    IF f.expiry_date IS NOT NULL AND f.expiry_date < _on THEN
      RETURN QUERY SELECT 'expired'::text, f.id, f.form_type, f.expiry_date;
    ELSE
      RETURN QUERY SELECT 'valid'::text, f.id, f.form_type, f.expiry_date;
    END IF;
    RETURN;
  END IF;
  SELECT * INTO f FROM public.broker_tax_forms WHERE broker_id = _broker AND status = 'rejected' ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'rejected'::text, f.id, f.form_type, f.expiry_date;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'missing'::text, NULL::uuid, NULL::text, NULL::date;
END;
$$;

-- The old flag is only a cache of the above, kept in step by the database. A login can't set it.
CREATE OR REPLACE FUNCTION public.sync_broker_tax_flag(_broker uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM public.broker_tax_form_state(_broker);
  PERFORM set_config('app.tax_sync', 'on', true);
  UPDATE public.brokers SET tax_form_verified = (s.state = 'valid'), tax_form_verified_at = CASE WHEN s.state = 'valid' THEN COALESCE(tax_form_verified_at, now()) ELSE NULL END WHERE id = _broker;
  PERFORM set_config('app.tax_sync', 'off', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.broker_tax_forms_sync_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.sync_broker_tax_flag(NEW.broker_id);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS broker_tax_forms_sync ON public.broker_tax_forms;
CREATE TRIGGER broker_tax_forms_sync AFTER INSERT OR UPDATE OF status ON public.broker_tax_forms FOR EACH ROW EXECUTE FUNCTION public.broker_tax_forms_sync_trigger();

CREATE OR REPLACE FUNCTION public.brokers_guard_tax_flag()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND COALESCE(current_setting('app.tax_sync', true), '') <> 'on'
     AND (NEW.tax_form_verified IS DISTINCT FROM OLD.tax_form_verified OR NEW.tax_form_verified_at IS DISTINCT FROM OLD.tax_form_verified_at) THEN
    NEW.tax_form_verified := OLD.tax_form_verified;
    NEW.tax_form_verified_at := OLD.tax_form_verified_at;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS brokers_tax_flag_guard ON public.brokers;
CREATE TRIGGER brokers_tax_flag_guard BEFORE UPDATE ON public.brokers FOR EACH ROW EXECUTE FUNCTION public.brokers_guard_tax_flag();

-- A broker's form (checked and encrypted by the app). The earlier valid form is superseded; the new one is valid at once.
CREATE OR REPLACE FUNCTION public.record_broker_tax_form(_broker uuid, _form jsonb, _secret jsonb, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_id uuid := (_form->>'id')::uuid;
BEGIN
  UPDATE public.broker_tax_forms SET status = 'superseded' WHERE broker_id = _broker AND status = 'valid';
  INSERT INTO public.broker_tax_forms (id, broker_id, form_type, is_us_person, entity_kind, legal_name, address, country, tin_kind, tin_last4, signed_name, signed_at, expiry_date, ip, user_agent)
  VALUES (new_id, _broker, _form->>'form_type', (_form->>'is_us_person')::boolean, _form->>'entity_kind', _form->>'legal_name', _form->>'address', _form->>'country', _form->>'tin_kind',
          NULLIF(_form->>'tin_last4', ''), _form->>'signed_name', (_form->>'signed_at')::timestamptz, NULLIF(_form->>'expiry_date', '')::date, _meta->>'ip_address', _meta->>'user_agent');
  IF _secret IS NOT NULL AND _secret <> 'null'::jsonb THEN
    INSERT INTO public.broker_tax_form_secrets (form_id, ciphertext, iv, auth_tag, key_version) VALUES (new_id, _secret->>'ciphertext', _secret->>'iv', _secret->>'auth_tag', (_secret->>'key_version')::integer);
  END IF;
  -- No TIN, not even its last four, in the audit trail.
  PERFORM public.tax_audit(_actor, 'broker_tax_form.submitted', 'broker', _broker::text, jsonb_build_object('form_id', new_id, 'form_type', _form->>'form_type', 'expiry_date', _form->>'expiry_date',
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN new_id;
END;
$$;

-- The Manager's review: a form that is wrong is rejected, with a reason, and the broker is blocked again.
CREATE OR REPLACE FUNCTION public.reject_broker_tax_form(_id uuid, _reason text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE f public.broker_tax_forms%ROWTYPE;
BEGIN
  PERFORM public.tax_require_admin(_actor);
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'Say why the form is rejected.' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.broker_tax_forms SET status = 'rejected', reviewed_by = _actor, reviewed_at = now(), review_reason = left(btrim(_reason), 500) WHERE id = _id AND status = 'valid' RETURNING * INTO f;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only a valid form can be rejected.' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public.tax_audit(_actor, 'broker_tax_form.rejected', 'broker', f.broker_id::text, jsonb_build_object('form_id', _id, 'reason', btrim(_reason), 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 2. The tax vault: who may open the Tax-Ready Folder and the TINs of brokers and influencers
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tax_vault_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  revoked_at timestamptz,
  revoked_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS tax_vault_grants_one_active ON public.tax_vault_grants (user_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION public.has_tax_vault_access(_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user IS NOT NULL AND (public.has_role(_user, 'founder') OR EXISTS (SELECT 1 FROM public.tax_vault_grants WHERE user_id = _user AND revoked_at IS NULL));
$$;

CREATE OR REPLACE FUNCTION public.grant_tax_vault_access(_user uuid, _reason text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_id uuid;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'founder') THEN
    RAISE EXCEPTION 'Only the founder can grant access to the tax vault.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.has_role(_user, 'admin') THEN
    RAISE EXCEPTION 'Only an admin can be given access to the tax vault.' USING ERRCODE = 'check_violation';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'Say why access is being granted.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.tax_vault_grants (user_id, granted_by, reason) VALUES (_user, _actor, btrim(_reason)) ON CONFLICT (user_id) WHERE revoked_at IS NULL DO NOTHING RETURNING id INTO new_id;
  PERFORM public.tax_audit(_actor, 'tax_vault.access_granted', 'user', _user::text, jsonb_build_object('reason', btrim(_reason), 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_tax_vault_access(_user uuid, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'founder') THEN
    RAISE EXCEPTION 'Only the founder can revoke access to the tax vault.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.tax_vault_grants SET revoked_at = now(), revoked_by = _actor WHERE user_id = _user AND revoked_at IS NULL;
  PERFORM public.tax_audit(_actor, 'tax_vault.access_revoked', 'user', _user::text, jsonb_build_object('ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Influencers: paid directly, never through a Broker of Record
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.influencer_payees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  tax_form_type text CHECK (tax_form_type IS NULL OR tax_form_type IN ('W-9', 'W-8BEN', 'W-8BEN-E')),
  tax_form_status text NOT NULL DEFAULT 'missing' CHECK (tax_form_status IN ('missing', 'valid', 'rejected')),
  -- Known only from the form: a W-9 is a US person, a W-8 is not. NULL while there is no form.
  is_us_person boolean,
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  address text,
  tin_kind text CHECK (tin_kind IS NULL OR tin_kind IN ('ssn', 'ein', 'itin', 'foreign_tin', 'none')),
  tin_last4 text CHECK (tin_last4 IS NULL OR tin_last4 ~ '^[A-Za-z0-9]{4}$'),
  form_signed_on date,
  form_expiry_date date,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((tax_form_type IS NULL) = (tax_form_status = 'missing')),
  CHECK (tax_form_type IS NULL OR (is_us_person = (tax_form_type = 'W-9')))
);
CREATE TABLE IF NOT EXISTS public.influencer_payee_secrets (
  payee_id uuid PRIMARY KEY REFERENCES public.influencer_payees(id),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1)
);
CREATE TABLE IF NOT EXISTS public.influencer_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_id uuid NOT NULL REFERENCES public.influencer_payees(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  paid_at date NOT NULL,
  year integer GENERATED ALWAYS AS (extract(year FROM paid_at)::integer) STORED,
  memo text,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS influencer_payments_payee_idx ON public.influencer_payments (payee_id, year);

-- A payment is a record: it is never edited or deleted, only voided with a reason.
CREATE OR REPLACE FUNCTION public.influencer_payments_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An influencer payment is never deleted. Void it.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.payee_id <> OLD.payee_id OR NEW.amount_cents <> OLD.amount_cents OR NEW.paid_at <> OLD.paid_at OR NEW.memo IS DISTINCT FROM OLD.memo OR NEW.recorded_by <> OLD.recorded_by THEN
    RAISE EXCEPTION 'An influencer payment can''t be edited. Void it and record the right one.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL AND (NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
    RAISE EXCEPTION 'A voided payment stays voided.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS influencer_payments_history ON public.influencer_payments;
CREATE TRIGGER influencer_payments_history BEFORE UPDATE OR DELETE ON public.influencer_payments FOR EACH ROW EXECUTE FUNCTION public.influencer_payments_guard();

-- Save a payee and, if a form came with them, their form. The TIN is encrypted by the app.
CREATE OR REPLACE FUNCTION public.save_influencer_payee(_id uuid, _payee jsonb, _secret jsonb, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pid uuid := COALESCE(_id, gen_random_uuid());
  ft text := NULLIF(_payee->>'tax_form_type', '');
  existed boolean;
BEGIN
  PERFORM public.tax_require_admin(_actor);
  SELECT EXISTS (SELECT 1 FROM public.influencer_payees WHERE id = pid) INTO existed;
  IF ft IS NOT NULL AND ft NOT IN ('W-9', 'W-8BEN', 'W-8BEN-E') THEN
    RAISE EXCEPTION 'The form is a W-9, W-8BEN or W-8BEN-E.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.influencer_payees (id, name, tax_form_type, tax_form_status, is_us_person, country, address, tin_kind, tin_last4, form_signed_on, form_expiry_date, created_by)
  VALUES (pid, btrim(_payee->>'name'), ft, CASE WHEN ft IS NULL THEN 'missing' ELSE 'valid' END, CASE WHEN ft IS NULL THEN NULL ELSE ft = 'W-9' END,
          NULLIF(_payee->>'country', ''), NULLIF(btrim(COALESCE(_payee->>'address', '')), ''), NULLIF(_payee->>'tin_kind', ''), NULLIF(_payee->>'tin_last4', ''),
          NULLIF(_payee->>'form_signed_on', '')::date, NULLIF(_payee->>'form_expiry_date', '')::date, _actor)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, tax_form_type = EXCLUDED.tax_form_type, tax_form_status = EXCLUDED.tax_form_status, is_us_person = EXCLUDED.is_us_person,
    country = EXCLUDED.country, address = EXCLUDED.address, tin_kind = EXCLUDED.tin_kind, tin_last4 = EXCLUDED.tin_last4, form_signed_on = EXCLUDED.form_signed_on,
    form_expiry_date = EXCLUDED.form_expiry_date, updated_at = now();
  IF _secret IS NOT NULL AND _secret <> 'null'::jsonb THEN
    INSERT INTO public.influencer_payee_secrets (payee_id, ciphertext, iv, auth_tag, key_version) VALUES (pid, _secret->>'ciphertext', _secret->>'iv', _secret->>'auth_tag', (_secret->>'key_version')::integer)
    ON CONFLICT (payee_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, key_version = EXCLUDED.key_version;
  ELSIF ft IS NULL THEN
    DELETE FROM public.influencer_payee_secrets WHERE payee_id = pid;
  END IF;
  PERFORM public.tax_audit(_actor, CASE WHEN existed THEN 'influencer.payee_updated' ELSE 'influencer.payee_created' END, 'influencer_payee', pid::text,
    jsonb_build_object('tax_form_type', ft, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN pid;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_influencer_payment(_payee uuid, _amount_cents bigint, _paid_at date, _memo text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_id uuid;
BEGIN
  PERFORM public.tax_require_admin(_actor);
  IF NOT EXISTS (SELECT 1 FROM public.influencer_payees WHERE id = _payee) THEN
    RAISE EXCEPTION 'Payee not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF _amount_cents IS NULL OR _amount_cents <= 0 THEN
    RAISE EXCEPTION 'The amount must be above zero.' USING ERRCODE = 'check_violation';
  END IF;
  IF _paid_at IS NULL OR _paid_at > current_date THEN
    RAISE EXCEPTION 'The payment date can''t be in the future.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.influencer_payments (payee_id, amount_cents, paid_at, memo, recorded_by) VALUES (_payee, _amount_cents, _paid_at, NULLIF(btrim(COALESCE(_memo, '')), ''), _actor) RETURNING id INTO new_id;
  PERFORM public.tax_audit(_actor, 'influencer.payment_recorded', 'influencer_payee', _payee::text, jsonb_build_object('payment_id', new_id, 'amount_cents', _amount_cents, 'paid_at', _paid_at,
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.void_influencer_payment(_id uuid, _reason text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.influencer_payments%ROWTYPE;
BEGIN
  PERFORM public.tax_require_admin(_actor);
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'Say why the payment is being voided.' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.influencer_payments SET voided_at = now(), voided_by = _actor, void_reason = left(btrim(_reason), 500) WHERE id = _id AND voided_at IS NULL RETURNING * INTO p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That payment is already voided, or does not exist.' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM public.tax_audit(_actor, 'influencer.payment_voided', 'influencer_payee', p.payee_id::text, jsonb_build_object('payment_id', _id, 'reason', btrim(_reason)));
END;
$$;

-- The annual summary. A payee paid $600.00 or more in the year (voided payments don't count) is a 1099-NEC payee, unless their form says they
-- are not a US person: then there is NO 1099-NEC and they are flagged for the CPA. A payee with no valid form at all is a 1099-NEC payee with
-- the form flagged as missing (the CPA decides about backup withholding; nothing is computed here).
CREATE OR REPLACE FUNCTION public.influencer_annual_summary(_year integer)
RETURNS TABLE (payee_id uuid, name text, address text, country text, tax_form_type text, form_status text, tin_last4 text, payments integer, total_cents bigint, treatment text, issue text)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT p.id, p.name, p.address, p.country, p.tax_form_type,
         CASE WHEN p.tax_form_status = 'valid' AND p.form_expiry_date IS NOT NULL AND p.form_expiry_date < make_date(_year, 12, 31) THEN 'expired' ELSE p.tax_form_status END,
         p.tin_last4, count(x.id)::integer, COALESCE(sum(x.amount_cents), 0)::bigint,
         CASE WHEN COALESCE(sum(x.amount_cents), 0) < 60000 THEN 'below_threshold'
              WHEN p.is_us_person IS FALSE THEN 'w8_flag_for_cpa'
              ELSE '1099_nec' END,
         CASE WHEN COALESCE(sum(x.amount_cents), 0) < 60000 THEN NULL
              WHEN p.is_us_person IS FALSE THEN 'Non-US payee on a ' || p.tax_form_type || ': no 1099-NEC. Flagged for the CPA.'
              WHEN p.tax_form_status <> 'valid' THEN 'No valid tax form on file: collect a W-9.'
              WHEN p.tax_form_type IS NULL THEN 'No valid tax form on file: collect a W-9.'
              ELSE NULL END
  FROM public.influencer_payees p
  LEFT JOIN public.influencer_payments x ON x.payee_id = p.id AND x.year = _year AND x.voided_at IS NULL
  GROUP BY p.id
  HAVING count(x.id) > 0
  ORDER BY p.name, p.id;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 4. The Tax-Ready Folder
-- ---------------------------------------------------------------------------------------------------------
-- Who held a share at the END of a date: today's holder, unless the share changed hands later (the rule holder_shares_as_of uses).
CREATE OR REPLACE FUNCTION public.share_holder_on(_property uuid, _share integer, _date date)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT COALESCE(h.from_buyer_account_id, h.from_seller_id) FROM public.cap_table_history h
      WHERE h.property_id = _property AND h.share_number = _share AND h.changed_at >= (((_date + 1)::timestamp) AT TIME ZONE 'UTC') ORDER BY h.changed_at ASC LIMIT 1),
    (SELECT COALESCE(c.buyer_account_id, c.seller_id) FROM public.cap_table_entries c WHERE c.property_id = _property AND c.share_number = _share));
$$;

-- The 1099-S data and the per-share ownership records for a year, from the cap table and its history. No TIN, no tax figure.
CREATE OR REPLACE FUNCTION public.tax_ready_sections(_property uuid, _year integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  y0 date := make_date(_year, 1, 1);
  y1 date := make_date(_year, 12, 31);
  days_in_year integer := (make_date(_year, 12, 31) - make_date(_year, 1, 1)) + 1;
  sh record;
  ch record;
  seg_start date;
  seg_holder uuid;
  shares jsonb := '[]'::jsonb;
  segs jsonb;
  total_days integer;
  share_days_total bigint := 0;
  shares_ok boolean := true;
  members jsonb;
  year_end_total integer;
  sales jsonb;
  transfers jsonb;
  total_shares integer;
BEGIN
  SELECT count(*) INTO total_shares FROM public.cap_table_entries WHERE property_id = _property;
  FOR sh IN SELECT share_number FROM public.cap_table_entries WHERE property_id = _property ORDER BY share_number LOOP
    segs := '[]'::jsonb;
    seg_holder := public.share_holder_on(_property, sh.share_number, y0 - 1);
    seg_start := y0;
    total_days := 0;
    FOR ch IN SELECT changed_at::date AS d, COALESCE(to_buyer_account_id, to_seller_id) AS to_holder FROM public.cap_table_history
              WHERE property_id = _property AND share_number = sh.share_number AND changed_at::date BETWEEN y0 AND y1 ORDER BY changed_at LOOP
      IF ch.d > seg_start THEN
        segs := segs || jsonb_build_array(jsonb_build_object('holder_key', seg_holder, 'from', seg_start, 'to', ch.d - 1, 'days', ch.d - seg_start));
        total_days := total_days + (ch.d - seg_start);
      END IF;
      seg_holder := ch.to_holder;
      seg_start := ch.d;
    END LOOP;
    segs := segs || jsonb_build_array(jsonb_build_object('holder_key', seg_holder, 'from', seg_start, 'to', y1, 'days', (y1 - seg_start) + 1));
    total_days := total_days + ((y1 - seg_start) + 1);
    share_days_total := share_days_total + total_days;
    IF total_days <> days_in_year THEN
      shares_ok := false;
    END IF;
    shares := shares || jsonb_build_array(jsonb_build_object('share_number', sh.share_number, 'year_end_holder_key', public.share_holder_on(_property, sh.share_number, y1), 'days_accounted_for', total_days, 'periods', segs));
  END LOOP;

  -- Per member: shares held at year-end and share-days (a share held all year is the days in the year).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('member_key', m.member_key, 'year_end_shares', m.year_end, 'share_days', m.sd,
            'percent_of_share_days', CASE WHEN share_days_total > 0 THEN to_char(round(m.sd * 100.0 / share_days_total, 4), 'FM990.0000') ELSE '0.0000' END) ORDER BY m.member_key), '[]'::jsonb)
    INTO members
  FROM (SELECT k.member_key,
               (SELECT count(*) FROM jsonb_array_elements(shares) s WHERE (s->>'year_end_holder_key')::uuid = k.member_key)::integer AS year_end,
               (SELECT COALESCE(sum((p->>'days')::integer), 0) FROM jsonb_array_elements(shares) s, jsonb_array_elements(s->'periods') p WHERE (p->>'holder_key')::uuid = k.member_key)::bigint AS sd
        FROM (SELECT DISTINCT (p->>'holder_key')::uuid AS member_key FROM jsonb_array_elements(shares) s, jsonb_array_elements(s->'periods') p) k) m;

  SELECT COALESCE(sum(h.shares), 0) INTO year_end_total FROM public.holder_shares_as_of(_property, y1) h;
  -- The two ways of counting year-end ownership have to agree.
  IF year_end_total <> total_shares OR (SELECT COALESCE(sum((m->>'year_end_shares')::integer), 0) FROM jsonb_array_elements(members) m) <> total_shares
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(members) m JOIN public.holder_shares_as_of(_property, y1) h ON h.member_id = (m->>'member_key')::uuid WHERE h.shares <> (m->>'year_end_shares')::integer) THEN
    shares_ok := false;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('share_number', h.share_number, 'date', h.changed_at::date, 'transferor_member_key', COALESCE(h.from_buyer_account_id, h.from_seller_id),
            'transferee_member_key', COALESCE(h.to_buyer_account_id, h.to_seller_id), 'resale_transaction_id', h.resale_transaction_id) ORDER BY h.changed_at, h.share_number), '[]'::jsonb) INTO transfers
  FROM public.cap_table_history h WHERE h.property_id = _property AND h.changed_at::date BETWEEN y0 AND y1;

  -- 1099-S data: one line per completed sale of a share in the year (the transferor, the date, the gross proceeds, the property). No TIN here.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('resale_transaction_id', t.id, 'date', h.changed_at::date, 'share_number', h.share_number,
            'transferor_member_key', COALESCE(h.from_buyer_account_id, h.from_seller_id), 'transferee_member_key', COALESCE(h.to_buyer_account_id, h.to_seller_id),
            'gross_proceeds_cents', round(t.price * 100)::bigint, 'property_address', (SELECT address FROM public.properties WHERE id = _property)) ORDER BY h.changed_at, h.share_number), '[]'::jsonb) INTO sales
  FROM public.cap_table_history h JOIN public.resale_transactions t ON t.id = h.resale_transaction_id
  WHERE h.property_id = _property AND h.changed_at::date BETWEEN y0 AND y1 AND t.status = 'completed';

  RETURN jsonb_build_object('year', _year, 'shares', shares, 'members', members, 'transfers', transfers, 'sales_1099s', sales,
    'reconciliation', jsonb_build_object('total_shares', total_shares, 'year_end_shares', year_end_total, 'days_in_year', days_in_year, 'share_days_total', share_days_total,
      'share_days_expected', total_shares::bigint * days_in_year, 'reconciled', shares_ok AND share_days_total = total_shares::bigint * days_in_year));
END;
$$;

CREATE TABLE IF NOT EXISTS public.tax_ready_folders (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES public.properties(id),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  version integer NOT NULL CHECK (version >= 1),
  -- The folder's data with NO TIN in it.
  data jsonb NOT NULL,
  hash text NOT NULL,
  generated_by uuid,
  generated_at timestamptz NOT NULL DEFAULT now(),
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (property_id, year, version)
);
CREATE OR REPLACE FUNCTION public.tax_ready_folders_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A Tax-Ready Folder is never deleted. A correction is a new version.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.property_id <> OLD.property_id OR NEW.year <> OLD.year OR NEW.version <> OLD.version OR NEW.data IS DISTINCT FROM OLD.data OR NEW.hash <> OLD.hash
     OR NEW.generated_by IS DISTINCT FROM OLD.generated_by OR NEW.generated_at <> OLD.generated_at THEN
    RAISE EXCEPTION 'A Tax-Ready Folder is a snapshot and can''t be edited. A correction is a new version.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.files <> '[]'::jsonb AND NEW.files IS DISTINCT FROM OLD.files THEN
    RAISE EXCEPTION 'A folder''s files are fixed once they are made.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tax_ready_folders_history ON public.tax_ready_folders;
CREATE TRIGGER tax_ready_folders_history BEFORE UPDATE OR DELETE ON public.tax_ready_folders FOR EACH ROW EXECUTE FUNCTION public.tax_ready_folders_guard();

-- Recording a folder needs the tax-vault permission (or the scheduled job, with no person).
CREATE OR REPLACE FUNCTION public.record_tax_ready_folder(_id uuid, _property uuid, _year integer, _data jsonb, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v integer;
  h text;
BEGIN
  IF _actor IS NOT NULL AND NOT public.has_tax_vault_access(_actor) THEN
    RAISE EXCEPTION 'You don''t have access to the tax vault.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF make_date(_year, 12, 31) >= current_date THEN
    RAISE EXCEPTION 'A Tax-Ready Folder is made after the year has ended.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO v FROM public.tax_ready_folders WHERE property_id = _property AND year = _year;
  h := encode(sha256(convert_to(_data::text, 'UTF8')), 'hex');
  INSERT INTO public.tax_ready_folders (id, property_id, year, version, data, hash, generated_by) VALUES (_id, _property, _year, v, _data, h, _actor);
  PERFORM public.tax_audit(_actor, 'tax_ready.generated', 'tax_ready_folder', _id::text, jsonb_build_object('property_id', _property, 'year', _year, 'version', v, 'hash', h,
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('id', _id, 'version', v, 'hash', h);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_tax_ready_files(_id uuid, _files jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.tax_ready_folders SET files = _files WHERE id = _id AND files = '[]'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_tax_vault_read(_actor uuid, _action text, _entity_type text, _id text, _meta jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.tax_audit(_actor, _action, _entity_type, _id, _meta);
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. Access
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE public.broker_tax_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broker_tax_form_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_vault_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.influencer_payees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.influencer_payee_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.influencer_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_ready_folders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.broker_tax_forms, public.broker_tax_form_secrets, public.tax_vault_grants, public.influencer_payees, public.influencer_payee_secrets, public.influencer_payments, public.tax_ready_folders
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.broker_tax_forms, public.influencer_payees, public.influencer_payments, public.tax_vault_grants TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.broker_tax_forms, public.broker_tax_form_secrets, public.influencer_payees, public.influencer_payee_secrets, public.influencer_payments, public.tax_vault_grants, public.tax_ready_folders TO service_role;
GRANT SELECT ON public.tax_ready_folders TO authenticated;

-- A broker reads their own form (never the TIN: that table has no policy). The Manager reads the forms' details. Influencers: the Manager.
DROP POLICY IF EXISTS "the broker and the Manager read the form" ON public.broker_tax_forms;
CREATE POLICY "the broker and the Manager read the form" ON public.broker_tax_forms FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR broker_id IN (SELECT b.id FROM public.brokers b WHERE b.auth_user_id = auth.uid()));
DROP POLICY IF EXISTS "the Manager reads influencer payees" ON public.influencer_payees;
CREATE POLICY "the Manager reads influencer payees" ON public.influencer_payees FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS "the Manager reads influencer payments" ON public.influencer_payments;
CREATE POLICY "the Manager reads influencer payments" ON public.influencer_payments FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS "the founder reads the vault grants" ON public.tax_vault_grants;
CREATE POLICY "the founder reads the vault grants" ON public.tax_vault_grants FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'founder'));
-- The Tax-Ready Folder: only with the tax-vault permission. A regular admin does not have it by being an admin.
DROP POLICY IF EXISTS "the tax vault reads the folders" ON public.tax_ready_folders;
CREATE POLICY "the tax vault reads the folders" ON public.tax_ready_folders FOR SELECT TO authenticated USING (public.has_tax_vault_access(auth.uid()));

INSERT INTO storage.buckets (id, name, public) VALUES ('tax-ready', 'tax-ready', false) ON CONFLICT (id) DO NOTHING;

REVOKE ALL ON FUNCTION public.tax_audit(uuid, text, text, text, jsonb), public.tax_require_admin(uuid), public.broker_tax_form_state(uuid, date), public.sync_broker_tax_flag(uuid),
  public.broker_tax_forms_sync_trigger(), public.brokers_guard_tax_flag(), public.record_broker_tax_form(uuid, jsonb, jsonb, uuid, jsonb), public.reject_broker_tax_form(uuid, text, uuid, jsonb),
  public.has_tax_vault_access(uuid), public.grant_tax_vault_access(uuid, text, uuid, jsonb), public.revoke_tax_vault_access(uuid, uuid, jsonb), public.influencer_payments_guard(),
  public.save_influencer_payee(uuid, jsonb, jsonb, uuid, jsonb), public.record_influencer_payment(uuid, bigint, date, text, uuid, jsonb), public.void_influencer_payment(uuid, text, uuid, jsonb),
  public.influencer_annual_summary(integer), public.share_holder_on(uuid, integer, date), public.tax_ready_sections(uuid, integer), public.tax_ready_folders_guard(),
  public.record_tax_ready_folder(uuid, uuid, integer, jsonb, uuid, jsonb), public.set_tax_ready_files(uuid, jsonb), public.log_tax_vault_read(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.broker_tax_form_state(uuid, date), public.sync_broker_tax_flag(uuid), public.record_broker_tax_form(uuid, jsonb, jsonb, uuid, jsonb),
  public.reject_broker_tax_form(uuid, text, uuid, jsonb), public.has_tax_vault_access(uuid), public.grant_tax_vault_access(uuid, text, uuid, jsonb), public.revoke_tax_vault_access(uuid, uuid, jsonb),
  public.save_influencer_payee(uuid, jsonb, jsonb, uuid, jsonb), public.record_influencer_payment(uuid, bigint, date, text, uuid, jsonb), public.void_influencer_payment(uuid, text, uuid, jsonb),
  public.influencer_annual_summary(integer), public.share_holder_on(uuid, integer, date), public.tax_ready_sections(uuid, integer), public.record_tax_ready_folder(uuid, uuid, integer, jsonb, uuid, jsonb),
  public.set_tax_ready_files(uuid, jsonb), public.log_tax_vault_read(uuid, text, text, text, jsonb) TO service_role;
-- The login policies above call has_tax_vault_access as the signed-in person.
GRANT EXECUTE ON FUNCTION public.has_tax_vault_access(uuid) TO authenticated;
