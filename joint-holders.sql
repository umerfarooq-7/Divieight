-- Joint holders. Run once in the Supabase SQL editor, after joint-reservations.sql and property-scope.sql. Safe to re-run.
--
-- A share two co-buyers hold together keeps ONE cap-table row (so the pod, the LLC and the share count are unchanged). That row names
-- the buyer who reserved it, and now also the co-holder. The co-holder can see the property's records and the owner area for it,
-- completes their own due diligence and authorizations, signs their own documents, and votes the share (the first of the two to vote
-- casts it). Money (earnest money, closing funds, distributions) stays with the buyer who reserved and paid.

ALTER TABLE public.cap_table_entries
  ADD COLUMN IF NOT EXISTS co_holder_account_id uuid REFERENCES public.buyer_accounts (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS cap_table_entries_co_holder_idx
  ON public.cap_table_entries (co_holder_account_id) WHERE co_holder_account_id IS NOT NULL;

-- Who may see a property's records: the same rule as before, and a joint holder (and their tethered agent) too.
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
          OR EXISTS (SELECT 1 FROM public.cap_table_entries c WHERE (c.buyer_account_id = b.id OR c.co_holder_account_id = b.id) AND c.property_id = _property)
          OR EXISTS (SELECT 1 FROM public.joint_reservations j WHERE j.partner_account_id = b.id AND j.property_id = _property)
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
            SELECT 1 FROM public.buyer_accounts b
            JOIN public.joint_reservations j ON j.partner_account_id = b.id
            WHERE b.tethered_resident_agent_id = a.id AND j.property_id = _property AND j.status = 'active'
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
