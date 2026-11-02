-- Post-closing Owner Dashboard. Run once in the Supabase SQL editor. Safe to re-run.
-- Only adds: two helper functions and one table. Existing tables and policies are untouched.

-- 1. Who owns what, read from the cap table. A signed-in user may only ask about
--    themselves; admins and server code (service role) may ask about anyone.
CREATE OR REPLACE FUNCTION public.owned_share_count(_user uuid, _property uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::integer
  FROM public.cap_table_entries c
  WHERE c.property_id = _property
    AND (_user = auth.uid() OR auth.role() = 'service_role' OR public.has_role(auth.uid(), 'admin'))
    AND (
      (c.holder_type = 'buyer_account' AND c.buyer_account_id IN (
        SELECT b.id FROM public.buyer_accounts b WHERE b.auth_user_id = _user
      ))
      OR (c.holder_type = 'retained_seller' AND c.seller_id = _user)
    );
$$;

CREATE OR REPLACE FUNCTION public.is_property_owner(_user uuid, _property uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.owned_share_count(_user, _property) > 0;
$$;

REVOKE ALL ON FUNCTION public.owned_share_count(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.is_property_owner(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.owned_share_count(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_property_owner(uuid, uuid) TO authenticated, service_role;

-- 2. Capital account summary. Placeholder only: no accounting logic until Month 6.
CREATE TABLE IF NOT EXISTS public.owner_capital_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  contributed_amount numeric NOT NULL DEFAULT 0,
  distributions_amount numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, user_id)
);
CREATE INDEX IF NOT EXISTS owner_capital_accounts_user_idx ON public.owner_capital_accounts (user_id);

GRANT SELECT ON public.owner_capital_accounts TO authenticated;
GRANT ALL ON public.owner_capital_accounts TO service_role;
ALTER TABLE public.owner_capital_accounts ENABLE ROW LEVEL SECURITY;

-- An owner sees only their own row, and only for a property they own.
DROP POLICY IF EXISTS "owners read own capital account" ON public.owner_capital_accounts;
CREATE POLICY "owners read own capital account" ON public.owner_capital_accounts
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.is_property_owner(auth.uid(), property_id));
