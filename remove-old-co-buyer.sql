-- Removes the earlier "co-buyer as a separate account" design (co-buyer-links.sql, joint-reservations.sql, joint-holders.sql).
-- A co-buyer is now a limited sub-account of the main buyer's own account (co-buyer-members.sql). Run once in the Supabase SQL editor. Safe to re-run.
-- Only the tables and column that design added are removed; nothing else is touched.

DROP TABLE IF EXISTS public.joint_reservations CASCADE;
DROP TABLE IF EXISTS public.joint_reservation_requests CASCADE;
DROP TABLE IF EXISTS public.co_buyer_links CASCADE;

DROP INDEX IF EXISTS public.cap_table_entries_co_holder_idx;
ALTER TABLE public.cap_table_entries DROP COLUMN IF EXISTS co_holder_account_id;

-- Back to the original access rule (the one in property-scope.sql): admin, the seller, a buyer account holding or having held a share, their tethered
-- agent, the accepted Heavy Lifting Agent, the listing agent.
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
