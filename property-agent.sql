-- Per-property Resident Agent + the reservation-time dual-agency checkpoint.
-- Run once in the Supabase SQL editor, AFTER property-scope.sql. Safe to re-run.
-- Deletes nothing; loosens no existing policy.

-- 1. A buyer's agent for ONE property, when their account-level agent holds
--    that property's listing. Their other properties keep the account agent.
CREATE TABLE IF NOT EXISTS public.property_agent_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  resident_agent_id uuid NOT NULL REFERENCES public.agents(id),
  -- The agent replaced on this property (the Listing Agent).
  replaced_agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  -- The replaced agent was the buyer's referrer and keeps the 25% referral share.
  referral_preserved boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT 'dual_agency_listing_agent',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_account_id, property_id),
  CHECK (resident_agent_id IS DISTINCT FROM replaced_agent_id)
);
CREATE INDEX IF NOT EXISTS property_agent_overrides_agent_idx ON public.property_agent_overrides (resident_agent_id);
CREATE INDEX IF NOT EXISTS property_agent_overrides_property_idx ON public.property_agent_overrides (property_id);

GRANT SELECT ON public.property_agent_overrides TO authenticated;
GRANT ALL ON public.property_agent_overrides TO service_role;
ALTER TABLE public.property_agent_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own property agent overrides" ON public.property_agent_overrides;
CREATE POLICY "own property agent overrides" ON public.property_agent_overrides
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = buyer_account_id AND b.auth_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.agents a WHERE a.id = resident_agent_id AND a.auth_user_id = auth.uid())
  );
-- Writes only through reserve_share_with_agent() / the service role.

-- 2. The buyer's agent on a property (override first, else the account tether).
CREATE OR REPLACE FUNCTION public.effective_resident_agent(_buyer uuid, _property uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT o.resident_agent_id FROM public.property_agent_overrides o
      WHERE o.buyer_account_id = _buyer AND o.property_id = _property),
    (SELECT b.tethered_resident_agent_id FROM public.buyer_accounts b WHERE b.id = _buyer)
  );
$$;
REVOKE ALL ON FUNCTION public.effective_resident_agent(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.effective_resident_agent(uuid, uuid) TO authenticated, service_role;

-- 3. Reserve + per-property agent in ONE transaction (called with the buyer's session).
CREATE OR REPLACE FUNCTION public.reserve_share_with_agent(
  p_property_id uuid,
  p_resident_agent_id uuid,
  p_replaced_agent_id uuid,
  p_referral_preserved boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _buyer public.buyer_accounts%ROWTYPE;
  _listing uuid;
  _reservation uuid;
BEGIN
  SELECT * INTO _buyer FROM public.buyer_accounts WHERE auth_user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No buyer account for this session' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT listing_agent_id INTO _listing FROM public.properties WHERE id = p_property_id;
  IF _listing IS NULL OR _listing IS DISTINCT FROM p_replaced_agent_id
     OR _buyer.tethered_resident_agent_id IS DISTINCT FROM _listing THEN
    RAISE EXCEPTION 'No listing-agent conflict to resolve on this property' USING ERRCODE = 'check_violation';
  END IF;
  IF p_resident_agent_id IS NULL OR p_resident_agent_id = _listing THEN
    RAISE EXCEPTION 'The Listing Agent cannot represent a buyer in this pod' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pod_reservations
    WHERE property_id = p_property_id AND buyer_account_id = _buyer.id AND status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'Already reserved' USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.property_agent_overrides
    (buyer_account_id, property_id, resident_agent_id, replaced_agent_id, referral_preserved, created_by)
  VALUES
    (_buyer.id, p_property_id, p_resident_agent_id, p_replaced_agent_id,
     COALESCE(p_referral_preserved, false) AND _buyer.referring_agent_id = p_replaced_agent_id, auth.uid())
  ON CONFLICT (buyer_account_id, property_id) DO UPDATE
    SET resident_agent_id = EXCLUDED.resident_agent_id,
        replaced_agent_id = EXCLUDED.replaced_agent_id,
        referral_preserved = EXCLUDED.referral_preserved,
        created_by = EXCLUDED.created_by;

  INSERT INTO public.pod_reservations (property_id, buyer_account_id, shares_reserved, status)
  VALUES (p_property_id, _buyer.id, 1, 'reserved')
  RETURNING id INTO _reservation;

  RETURN _reservation;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_share_with_agent(uuid, uuid, uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.reserve_share_with_agent(uuid, uuid, uuid, boolean) TO authenticated;

-- 4. Direct API inserts by a signed-in user can't bypass the checkpoint.
--    (Server code using the service role is unaffected.)
CREATE OR REPLACE FUNCTION public.enforce_reservation_dual_agency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR NEW.status IS DISTINCT FROM 'reserved' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.properties p
    WHERE p.id = NEW.property_id
      AND p.listing_agent_id IS NOT NULL
      AND p.listing_agent_id = public.effective_resident_agent(NEW.buyer_account_id, NEW.property_id)
  ) THEN
    RAISE EXCEPTION 'DUAL_AGENCY_CONFLICT: your agent holds the listing on this property — choose a different agent for it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reservation_dual_agency ON public.pod_reservations;
CREATE TRIGGER reservation_dual_agency
  BEFORE INSERT OR UPDATE OF status, property_id, buyer_account_id ON public.pod_reservations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_reservation_dual_agency();

-- 5. Property access (from property-scope.sql) now also follows per-property agents.
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
            SELECT 1 FROM public.pod_reservations r
            WHERE r.property_id = _property AND r.status = 'reserved'
              AND public.effective_resident_agent(r.buyer_account_id, _property) = a.id
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
