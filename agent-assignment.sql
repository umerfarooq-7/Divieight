-- "Let divieight choose an agent for me": the buyer's request and the admin queue.
-- Run once in the Supabase SQL editor, AFTER property-agent.sql. Safe to re-run.
-- Existing columns and policies are untouched; nothing is deleted.

-- 1. How this Buyer Account's account-level agent is chosen.
ALTER TABLE public.buyer_accounts
  ADD COLUMN IF NOT EXISTS agent_selection_mode text NOT NULL DEFAULT 'self_selected',
  ADD COLUMN IF NOT EXISTS platform_assignment_status text,
  ADD COLUMN IF NOT EXISTS platform_assignment_requested_at timestamptz;

ALTER TABLE public.buyer_accounts DROP CONSTRAINT IF EXISTS buyer_accounts_agent_selection_mode_check;
ALTER TABLE public.buyer_accounts ADD CONSTRAINT buyer_accounts_agent_selection_mode_check
  CHECK (agent_selection_mode IN ('self_selected', 'platform_assigned'));
ALTER TABLE public.buyer_accounts DROP CONSTRAINT IF EXISTS buyer_accounts_platform_assignment_status_check;
ALTER TABLE public.buyer_accounts ADD CONSTRAINT buyer_accounts_platform_assignment_status_check
  CHECK (platform_assignment_status IS NULL OR platform_assignment_status IN ('pending', 'assigned'));

-- 2. The queue. property_id NULL = the account's agent; set = one property only
--    (the buyer's agent holds that listing).
CREATE TABLE IF NOT EXISTS public.agent_assignment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.properties(id) ON DELETE CASCADE,
  -- pending: waiting on admin · assigned: waiting on the agent's accept/decline
  -- accepted: tether in place · cancelled: the buyer chose their own agent
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'accepted', 'cancelled')),
  assigned_agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  assigned_by uuid,
  assigned_at timestamptz,
  responded_at timestamptz,
  -- Property requests: the agent being replaced, and whether they keep the referral share.
  replaced_agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  referral_preserved boolean NOT NULL DEFAULT false,
  requested_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One open request per account, and per (account, property).
CREATE UNIQUE INDEX IF NOT EXISTS agent_assignment_open_account_key
  ON public.agent_assignment_requests (buyer_account_id)
  WHERE property_id IS NULL AND status IN ('pending', 'assigned');
CREATE UNIQUE INDEX IF NOT EXISTS agent_assignment_open_property_key
  ON public.agent_assignment_requests (buyer_account_id, property_id)
  WHERE property_id IS NOT NULL AND status IN ('pending', 'assigned');
CREATE INDEX IF NOT EXISTS agent_assignment_status_idx
  ON public.agent_assignment_requests (status, requested_at);
CREATE INDEX IF NOT EXISTS agent_assignment_agent_idx
  ON public.agent_assignment_requests (assigned_agent_id);

-- 3. Agents who declined a request are never offered it again
--    (same idea as listing_agent_declines on the seller side).
CREATE TABLE IF NOT EXISTS public.agent_assignment_declines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.agent_assignment_requests(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_assignment_declines_request_idx
  ON public.agent_assignment_declines (request_id);

-- 4. Reads through RLS for the people involved; every write goes through server
--    functions using the service role.
GRANT SELECT ON public.agent_assignment_requests, public.agent_assignment_declines TO authenticated;
GRANT ALL ON public.agent_assignment_requests, public.agent_assignment_declines TO service_role;
ALTER TABLE public.agent_assignment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_assignment_declines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own agent assignment requests" ON public.agent_assignment_requests;
CREATE POLICY "own agent assignment requests" ON public.agent_assignment_requests
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = buyer_account_id AND b.auth_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.agents a WHERE a.id = assigned_agent_id AND a.auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "admins read agent assignment declines" ON public.agent_assignment_declines;
CREATE POLICY "admins read agent assignment declines" ON public.agent_assignment_declines
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
