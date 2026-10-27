-- Property scoping for buyer/agent records.
-- Run once in the Supabase SQL editor. Safe to re-run. Deletes nothing and
-- loosens no existing policy: it only ADDS columns, triggers, indexes and
-- RESTRICTIVE select policies (which can only narrow what a user may read).
-- The final SELECT prints the backfill counts.

-- 1. Who may see a property's records ---------------------------------------
-- admin · the property's seller · a Buyer Account holding (or having held) a
-- share in it · the tethered Resident Agent of a buyer reserved in it · the
-- pod's accepted Heavy Lifting Agent · the property's Listing Agent.
CREATE OR REPLACE FUNCTION public.user_has_property_access(_user uuid, _property uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user IS NOT NULL AND _property IS NOT NULL AND (
    public.has_role(_user, 'admin')
    OR EXISTS (SELECT 1 FROM public.properties p WHERE p.id = _property AND p.seller_id = _user)
    OR EXISTS (
      SELECT 1 FROM public.buyer_accounts b
      WHERE b.auth_user_id = _user
        AND (
          EXISTS (SELECT 1 FROM public.pod_reservations r WHERE r.buyer_account_id = b.id AND r.property_id = _property)
          OR EXISTS (SELECT 1 FROM public.cap_table_entries c WHERE c.buyer_account_id = b.id AND c.property_id = _property)
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.agents a
      WHERE a.auth_user_id = _user
        AND (
          EXISTS (
            SELECT 1 FROM public.buyer_accounts b
            JOIN public.pod_reservations r ON r.buyer_account_id = b.id
            WHERE b.tethered_resident_agent_id = a.id AND r.property_id = _property AND r.status = 'reserved'
          )
          OR EXISTS (
            SELECT 1 FROM public.pods pd
            WHERE pd.property_id = _property AND pd.heavy_lifting_agent_id = a.id AND pd.hla_status = 'accepted'
          )
          OR EXISTS (SELECT 1 FROM public.properties p WHERE p.id = _property AND p.listing_agent_id = a.id)
        )
    )
  );
$$;

REVOKE ALL ON FUNCTION public.user_has_property_access(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.user_has_property_access(uuid, uuid) TO authenticated, service_role;

-- 2. property_id on child tables that only pointed at their parent ------------
ALTER TABLE public.authorization_responses            ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.properties(id) ON DELETE CASCADE;
ALTER TABLE public.authorization_commission_items     ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.properties(id) ON DELETE CASCADE;
ALTER TABLE public.authorization_commission_responses ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.properties(id) ON DELETE CASCADE;
ALTER TABLE public.report_annotations                 ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.properties(id) ON DELETE CASCADE;

-- New rows inherit property_id from their parent; a mismatching value is refused.
CREATE OR REPLACE FUNCTION public.inherit_property_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _parent uuid;
BEGIN
  IF TG_TABLE_NAME = 'report_annotations' THEN
    SELECT property_id INTO _parent FROM public.property_reports WHERE id = NEW.report_id;
  ELSE
    SELECT property_id INTO _parent FROM public.authorization_requests WHERE id = NEW.request_id;
  END IF;
  IF _parent IS NULL THEN
    RAISE EXCEPTION '%: parent record has no property', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.property_id IS NOT NULL AND NEW.property_id <> _parent THEN
    RAISE EXCEPTION '%: property_id does not match the parent record', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  NEW.property_id := _parent;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inherit_property_id ON public.authorization_responses;
CREATE TRIGGER inherit_property_id BEFORE INSERT OR UPDATE OF request_id, property_id ON public.authorization_responses
  FOR EACH ROW EXECUTE FUNCTION public.inherit_property_id();
DROP TRIGGER IF EXISTS inherit_property_id ON public.authorization_commission_items;
CREATE TRIGGER inherit_property_id BEFORE INSERT OR UPDATE OF request_id, property_id ON public.authorization_commission_items
  FOR EACH ROW EXECUTE FUNCTION public.inherit_property_id();
DROP TRIGGER IF EXISTS inherit_property_id ON public.authorization_commission_responses;
CREATE TRIGGER inherit_property_id BEFORE INSERT OR UPDATE OF request_id, property_id ON public.authorization_commission_responses
  FOR EACH ROW EXECUTE FUNCTION public.inherit_property_id();
DROP TRIGGER IF EXISTS inherit_property_id ON public.report_annotations;
CREATE TRIGGER inherit_property_id BEFORE INSERT OR UPDATE OF report_id, property_id ON public.report_annotations
  FOR EACH ROW EXECUTE FUNCTION public.inherit_property_id();

-- Backfill existing rows from the parent, record counts, then NOT NULL where no gaps remain.
CREATE TEMP TABLE IF NOT EXISTS _property_scope_backfill (
  table_name text PRIMARY KEY, rows_backfilled bigint, rows_still_null bigint, not_null_set boolean
) ON COMMIT PRESERVE ROWS;
TRUNCATE _property_scope_backfill;

DO $$
DECLARE
  t text;
  updated bigint;
  remaining bigint;
BEGIN
  UPDATE public.authorization_responses x SET property_id = r.property_id
    FROM public.authorization_requests r WHERE r.id = x.request_id AND x.property_id IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  INSERT INTO _property_scope_backfill VALUES ('authorization_responses', updated, NULL, false);

  UPDATE public.authorization_commission_items x SET property_id = r.property_id
    FROM public.authorization_requests r WHERE r.id = x.request_id AND x.property_id IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  INSERT INTO _property_scope_backfill VALUES ('authorization_commission_items', updated, NULL, false);

  UPDATE public.authorization_commission_responses x SET property_id = r.property_id
    FROM public.authorization_requests r WHERE r.id = x.request_id AND x.property_id IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  INSERT INTO _property_scope_backfill VALUES ('authorization_commission_responses', updated, NULL, false);

  UPDATE public.report_annotations x SET property_id = p.property_id
    FROM public.property_reports p WHERE p.id = x.report_id AND x.property_id IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  INSERT INTO _property_scope_backfill VALUES ('report_annotations', updated, NULL, false);

  FOREACH t IN ARRAY ARRAY['authorization_responses','authorization_commission_items','authorization_commission_responses','report_annotations'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE property_id IS NULL', t) INTO remaining;
    IF remaining = 0 THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN property_id SET NOT NULL', t);
    END IF;
    UPDATE _property_scope_backfill SET rows_still_null = remaining, not_null_set = (remaining = 0) WHERE table_name = t;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS authorization_responses_property_idx            ON public.authorization_responses (property_id);
CREATE INDEX IF NOT EXISTS authorization_commission_items_property_idx     ON public.authorization_commission_items (property_id);
CREATE INDEX IF NOT EXISTS authorization_commission_responses_property_idx ON public.authorization_commission_responses (property_id);
CREATE INDEX IF NOT EXISTS report_annotations_property_idx                 ON public.report_annotations (property_id);

-- 3. RESTRICTIVE select policies: on top of every existing policy, a row is
-- readable only when its property is one the user is connected to. Server
-- functions use the service role and are unaffected.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'due_diligence_inventory', 'due_diligence_acknowledgments',
    'property_reports', 'report_annotations',
    'authorization_requests', 'authorization_responses',
    'authorization_commission_items', 'authorization_commission_responses',
    'earnest_money_terms', 'earnest_money_obligations',
    'closing_funds_terms', 'closing_funds_obligations'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "property scope" ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY "property scope" ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated
         USING (public.user_has_property_access(auth.uid(), property_id))', t);
  END LOOP;
END $$;

-- 4. Result: backfill counts per table.
SELECT * FROM _property_scope_backfill ORDER BY table_name;
