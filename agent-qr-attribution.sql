-- Agent QR / deep-link attribution (Module 20). Run once in the Supabase SQL editor. Safe to re-run.
-- Only adds tables. It never touches buyer_accounts, tether data or the older
-- attribution_tokens table and /r links, which keep working as they did.

CREATE TABLE IF NOT EXISTS public.agent_attribution_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE CHECK (token ~ '^[a-z2-9]{12}$'),
  label text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_attribution_tokens_agent_idx ON public.agent_attribution_tokens (agent_id, created_at DESC);
-- One live default per agent. Revoking it lets a fresh one be made on the next visit.
CREATE UNIQUE INDEX IF NOT EXISTS agent_attribution_tokens_one_default
  ON public.agent_attribution_tokens (agent_id) WHERE is_default AND revoked_at IS NULL;

-- No personal data: only a one-way hash of the browser's user-agent string.
CREATE TABLE IF NOT EXISTS public.attribution_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid NOT NULL REFERENCES public.agent_attribution_tokens(id) ON DELETE CASCADE,
  visited_at timestamptz NOT NULL DEFAULT now(),
  user_agent_hash text
);
CREATE INDEX IF NOT EXISTS attribution_visits_token_idx ON public.attribution_visits (token_id, visited_at DESC);

-- The stamp. First token wins: the unique key means it can never be overwritten.
-- A suggestion for the admin only: nothing here tethers a buyer or sets a referring agent.
CREATE TABLE IF NOT EXISTS public.buyer_attribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id uuid NOT NULL UNIQUE,
  token_id uuid REFERENCES public.agent_attribution_tokens(id) ON DELETE SET NULL,
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  stamped_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS buyer_attribution_agent_idx ON public.buyer_attribution (agent_id);

-- Read-only for signed-in users: every write goes through the server functions.
GRANT SELECT ON public.agent_attribution_tokens, public.attribution_visits, public.buyer_attribution TO authenticated;
GRANT ALL ON public.agent_attribution_tokens, public.attribution_visits, public.buyer_attribution TO service_role;
ALTER TABLE public.agent_attribution_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attribution_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buyer_attribution ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agents read their own attribution tokens" ON public.agent_attribution_tokens;
CREATE POLICY "agents read their own attribution tokens" ON public.agent_attribution_tokens
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.agents a WHERE a.id = agent_id AND a.auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "agents read their own attribution visits" ON public.attribution_visits;
CREATE POLICY "agents read their own attribution visits" ON public.attribution_visits
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.agent_attribution_tokens t JOIN public.agents a ON a.id = t.agent_id
      WHERE t.id = token_id AND a.auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "buyers and admins read the stamp" ON public.buyer_attribution;
CREATE POLICY "buyers and admins read the stamp" ON public.buyer_attribution
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR buyer_user_id = auth.uid());
