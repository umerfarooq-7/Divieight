-- Month 6, Prompt 12: the Designated CPA credential.
-- Run in the Supabase SQL editor AFTER cpa-role.sql (which must run on its own, first), bookkeeping.sql, capital-accounts.sql and
-- monthly-statements.sql. Safe to run again.
--
--   * The Manager designates ONE CPA per LLC (name, firm, email, optional license number). The CPA gets a limited login by invite.
--   * The CPA is read-only and scoped to that one property. There is deliberately NO policy and NO grant that lets the CPA's own login read
--     any table directly: every read goes through the server functions, which check this table (an active designation for THAT property)
--     on every call. So rescinding cuts access at once, with nothing cached, and a CPA can never read another property or any unrelated PII.
--   * Rescinding is final and audit logged. A new CPA is a new designation.
--   * Owners can see the designated CPA's name and firm and since when, and nothing else.

-- ---------------------------------------------------------------------------------------------------------
-- 1. The designation
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cpa_designations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  cpa_name text NOT NULL CHECK (btrim(cpa_name) <> ''),
  firm text NOT NULL CHECK (btrim(firm) <> ''),
  email text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  license_no text,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'rescinded')),
  -- The CPA's login (an auth user made by the invite). Set once the invite has been sent.
  auth_user_id uuid,
  designated_by uuid NOT NULL,
  designated_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  rescinded_at timestamptz,
  rescinded_by uuid,
  reason text,
  CHECK ((status = 'rescinded') = (rescinded_at IS NOT NULL)),
  CHECK (status <> 'rescinded' OR btrim(COALESCE(reason, '')) <> ''),
  CHECK (status <> 'active' OR activated_at IS NOT NULL)
);
-- One CPA per LLC at a time: an invited or active designation holds the place until it is rescinded.
CREATE UNIQUE INDEX IF NOT EXISTS cpa_designations_one_per_llc ON public.cpa_designations (property_id) WHERE status IN ('invited', 'active');
CREATE INDEX IF NOT EXISTS cpa_designations_user_idx ON public.cpa_designations (auth_user_id) WHERE auth_user_id IS NOT NULL;

-- A designation is never deleted or re-pointed; rescinded is final.
CREATE OR REPLACE FUNCTION public.cpa_designations_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A CPA designation is never deleted. Rescind it.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.property_id <> OLD.property_id OR NEW.cpa_name <> OLD.cpa_name OR NEW.firm <> OLD.firm OR lower(NEW.email) <> lower(OLD.email)
     OR NEW.designated_by <> OLD.designated_by OR NEW.designated_at <> OLD.designated_at THEN
    RAISE EXCEPTION 'A CPA designation can''t be edited. Rescind it and designate again.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.auth_user_id IS NOT NULL AND NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
    RAISE EXCEPTION 'A CPA designation''s login never changes.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'rescinded' THEN
    IF NEW.status <> 'rescinded' OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.rescinded_at IS DISTINCT FROM OLD.rescinded_at THEN
      RAISE EXCEPTION 'A rescinded designation stays rescinded.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status <> OLD.status AND NOT ((OLD.status = 'invited' AND NEW.status IN ('active', 'rescinded')) OR (OLD.status = 'active' AND NEW.status = 'rescinded')) THEN
    RAISE EXCEPTION 'A designation can''t go from % to %.', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS cpa_designations_history ON public.cpa_designations;
CREATE TRIGGER cpa_designations_history BEFORE UPDATE OR DELETE ON public.cpa_designations FOR EACH ROW EXECUTE FUNCTION public.cpa_designations_guard();

-- ---------------------------------------------------------------------------------------------------------
-- 2. Functions
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cpa_audit(_actor uuid, _action text, _id uuid, _meta jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_log (actor_id, actor_type, action_type, entity_type, entity_id, metadata)
  VALUES (_actor, CASE WHEN _action LIKE 'cpa.%' AND _action NOT IN ('cpa.designated', 'cpa.rescinded') THEN 'cpa' WHEN _actor IS NULL THEN 'system' ELSE 'admin' END, _action, 'cpa_designation', _id::text,
          _meta || jsonb_build_object('at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
END;
$$;

-- Is this person the active, designated CPA of this LLC right now? The one test every CPA read goes through.
CREATE OR REPLACE FUNCTION public.is_property_cpa(_user uuid, _property uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user IS NOT NULL AND EXISTS (SELECT 1 FROM public.cpa_designations WHERE auth_user_id = _user AND property_id = _property AND status = 'active');
$$;

-- The Manager designates a CPA. Refused while the LLC has one (invited or active): rescind first.
CREATE OR REPLACE FUNCTION public.designate_cpa(_property uuid, _name text, _firm text, _email text, _license text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  new_id uuid;
  held public.cpa_designations%ROWTYPE;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can do that.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = _property) THEN
    RAISE EXCEPTION 'Property not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO held FROM public.cpa_designations WHERE property_id = _property AND status IN ('invited', 'active');
  IF FOUND THEN
    RAISE EXCEPTION 'This LLC already has a designated CPA (%). Rescind that designation first: an LLC has one CPA at a time.', held.cpa_name USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.cpa_designations (property_id, cpa_name, firm, email, license_no, designated_by)
  VALUES (_property, btrim(_name), btrim(_firm), lower(btrim(_email)), NULLIF(btrim(COALESCE(_license, '')), ''), _actor) RETURNING id INTO new_id;
  PERFORM public.cpa_audit(_actor, 'cpa.designated', new_id, jsonb_build_object('property_id', _property, 'cpa_name', btrim(_name), 'firm', btrim(_firm), 'email', lower(btrim(_email)),
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN new_id;
END;
$$;

-- The invite has made (or found) the CPA's login: attach it. Service role only.
CREATE OR REPLACE FUNCTION public.attach_cpa_login(_id uuid, _auth_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.cpa_designations SET auth_user_id = _auth_user WHERE id = _id AND status = 'invited' AND auth_user_id IS NULL;
END;
$$;

-- The CPA's first sign-in turns an invited designation into an active one. Returns the designations that are active for this login.
CREATE OR REPLACE FUNCTION public.activate_cpa_designations(_user uuid)
RETURNS TABLE (designation_id uuid, property_id uuid, cpa_name text, firm text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d record;
BEGIN
  FOR d IN SELECT * FROM public.cpa_designations WHERE auth_user_id = _user AND status = 'invited' LOOP
    UPDATE public.cpa_designations SET status = 'active', activated_at = now() WHERE id = d.id;
    PERFORM public.cpa_audit(_user, 'cpa.activated', d.id, jsonb_build_object('property_id', d.property_id));
  END LOOP;
  RETURN QUERY SELECT c.id, c.property_id, c.cpa_name, c.firm FROM public.cpa_designations c WHERE c.auth_user_id = _user AND c.status = 'active' ORDER BY c.designated_at;
END;
$$;

-- Rescind: final, with a reason. Access ends this instant (every read asks is_property_cpa), and the app then closes the login.
CREATE OR REPLACE FUNCTION public.rescind_cpa(_id uuid, _reason text, _actor uuid, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d public.cpa_designations%ROWTYPE;
  other integer;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can do that.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF _reason IS NULL OR btrim(_reason) = '' THEN
    RAISE EXCEPTION 'Say why the CPA is being rescinded (change of CPA, dissolution...).' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO d FROM public.cpa_designations WHERE id = _id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Designation not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF d.status = 'rescinded' THEN
    RETURN jsonb_build_object('status', 'already_rescinded', 'auth_user_id', d.auth_user_id, 'other_active', 0);
  END IF;
  UPDATE public.cpa_designations SET status = 'rescinded', rescinded_at = now(), rescinded_by = _actor, reason = left(btrim(_reason), 1000) WHERE id = _id;
  SELECT count(*) INTO other FROM public.cpa_designations WHERE auth_user_id = d.auth_user_id AND status IN ('invited', 'active') AND d.auth_user_id IS NOT NULL;
  PERFORM public.cpa_audit(_actor, 'cpa.rescinded', _id, jsonb_build_object('property_id', d.property_id, 'cpa_name', d.cpa_name, 'was', d.status, 'reason', btrim(_reason),
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('status', 'rescinded', 'auth_user_id', d.auth_user_id, 'other_active', other);
END;
$$;

-- Members see who the designated CPA is, and since when: name and firm only. Nothing else about the designation.
CREATE OR REPLACE FUNCTION public.designated_cpa(_property uuid)
RETURNS TABLE (cpa_name text, firm text, since timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.cpa_name, c.firm, COALESCE(c.activated_at, c.designated_at)
  FROM public.cpa_designations c
  WHERE c.property_id = _property AND c.status IN ('invited', 'active')
    AND (public.is_property_owner(auth.uid(), _property) OR public.has_role(auth.uid(), 'admin'));
$$;

-- May this CPA see this W-9's TIN? Only for the property they are designated to, and only a W-9 of a member whose account holds shares in it.
CREATE OR REPLACE FUNCTION public.cpa_can_view_tin(_user uuid, _property uuid, _w9 uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_property_cpa(_user, _property)
     AND EXISTS (SELECT 1 FROM public.member_w9 w JOIN public.cap_table_entries c ON c.buyer_account_id = w.buyer_account_id WHERE w.id = _w9 AND c.property_id = _property);
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Access: nobody writes from a login, and the CPA's login reads nothing directly
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE public.cpa_designations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cpa_designations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.cpa_designations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cpa_designations TO service_role;

-- The Manager reads all of it. The CPA reads their OWN designation row (so the portal can say what they are designated to).
DROP POLICY IF EXISTS "manager and the CPA read designations" ON public.cpa_designations;
CREATE POLICY "manager and the CPA read designations" ON public.cpa_designations FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR (auth_user_id = auth.uid() AND status = 'active'));

REVOKE ALL ON FUNCTION public.cpa_designations_guard(), public.cpa_audit(uuid, text, uuid, jsonb), public.designate_cpa(uuid, text, text, text, text, uuid, jsonb),
  public.attach_cpa_login(uuid, uuid), public.activate_cpa_designations(uuid), public.rescind_cpa(uuid, text, uuid, jsonb), public.cpa_can_view_tin(uuid, uuid, uuid),
  public.is_property_cpa(uuid, uuid), public.designated_cpa(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.designate_cpa(uuid, text, text, text, text, uuid, jsonb), public.attach_cpa_login(uuid, uuid), public.activate_cpa_designations(uuid),
  public.rescind_cpa(uuid, text, uuid, jsonb), public.cpa_can_view_tin(uuid, uuid, uuid), public.is_property_cpa(uuid, uuid) TO service_role;
-- Members ask who their CPA is; the function itself checks they own the property.
GRANT EXECUTE ON FUNCTION public.designated_cpa(uuid) TO authenticated, service_role;
