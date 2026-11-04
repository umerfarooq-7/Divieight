-- One-time "You are now a co-owner" banner for Hybrid Exit sellers. Run once in
-- the Supabase SQL editor. Safe to re-run. Only adds one table.

CREATE TABLE IF NOT EXISTS public.owner_activation_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  shown_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, property_id)
);

-- Read-only for signed-in users: the server claims a row when it shows the banner.
GRANT SELECT ON public.owner_activation_notices TO authenticated;
GRANT ALL ON public.owner_activation_notices TO service_role;
ALTER TABLE public.owner_activation_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own activation notices" ON public.owner_activation_notices;
CREATE POLICY "users read own activation notices" ON public.owner_activation_notices
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
