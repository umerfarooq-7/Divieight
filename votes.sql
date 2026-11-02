-- Owner voting. Run once in the Supabase SQL editor, AFTER owner-dashboard.sql.
-- Safe to re-run. Only adds tables; existing tables are untouched.

CREATE TABLE IF NOT EXISTS public.votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  vote_type text NOT NULL CHECK (vote_type IN ('ordinary', 'major', 'unanimous')),
  options jsonb NOT NULL DEFAULT '["Yes","No","Abstain"]'::jsonb,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'cancelled')),
  created_by uuid,
  result_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at)
);
CREATE INDEX IF NOT EXISTS votes_property_idx ON public.votes (property_id, created_at DESC);

-- holder_key: the buyer_account_id, or 'seller:' || seller_id for a retained seller.
CREATE TABLE IF NOT EXISTS public.vote_ballots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id uuid NOT NULL REFERENCES public.votes(id) ON DELETE CASCADE,
  holder_key text NOT NULL,
  share_numbers integer[] NOT NULL DEFAULT '{}',
  cast_by_user_id uuid,
  choice text NOT NULL,
  cast_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vote_id, holder_key)
);

-- Internal consensus inside a multi-member Buyer Account. Members share the
-- account's login, so each position names the member it was recorded for.
CREATE TABLE IF NOT EXISTS public.vote_member_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id uuid NOT NULL REFERENCES public.votes(id) ON DELETE CASCADE,
  holder_key text NOT NULL,
  account_member_id uuid NOT NULL REFERENCES public.account_members(id) ON DELETE CASCADE,
  user_id uuid,
  position text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vote_id, account_member_id)
);

-- The window is enforced in the database too, for every writer.
CREATE OR REPLACE FUNCTION public.enforce_vote_window()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.votes v
    WHERE v.id = NEW.vote_id AND v.status = 'open' AND now() >= v.opens_at AND now() < v.closes_at
  ) THEN
    RAISE EXCEPTION 'This vote is not open' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS vote_ballots_window ON public.vote_ballots;
CREATE TRIGGER vote_ballots_window BEFORE INSERT OR UPDATE ON public.vote_ballots
  FOR EACH ROW EXECUTE FUNCTION public.enforce_vote_window();
DROP TRIGGER IF EXISTS vote_positions_window ON public.vote_member_positions;
CREATE TRIGGER vote_positions_window BEFORE INSERT OR UPDATE ON public.vote_member_positions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_vote_window();

-- True when this holder_key belongs to the user.
CREATE OR REPLACE FUNCTION public.is_own_holder_key(_user uuid, _holder_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user IS NOT NULL AND (
    _holder_key = 'seller:' || _user::text
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.auth_user_id = _user AND b.id::text = _holder_key)
  );
$$;
REVOKE ALL ON FUNCTION public.is_own_holder_key(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.is_own_holder_key(uuid, text) TO authenticated, service_role;

-- Read-only for signed-in users: every write goes through the server functions.
GRANT SELECT ON public.votes, public.vote_ballots, public.vote_member_positions TO authenticated;
GRANT ALL ON public.votes, public.vote_ballots, public.vote_member_positions TO service_role;
ALTER TABLE public.votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vote_ballots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vote_member_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owners read votes" ON public.votes;
CREATE POLICY "owners read votes" ON public.votes
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (status <> 'draft' AND public.is_property_owner(auth.uid(), property_id))
  );

-- An owner reads only their own holder's ballot and positions.
DROP POLICY IF EXISTS "holders read own ballot" ON public.vote_ballots;
CREATE POLICY "holders read own ballot" ON public.vote_ballots
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (
      public.is_own_holder_key(auth.uid(), holder_key)
      AND EXISTS (SELECT 1 FROM public.votes v WHERE v.id = vote_id AND public.is_property_owner(auth.uid(), v.property_id))
    )
  );

DROP POLICY IF EXISTS "holders read own positions" ON public.vote_member_positions;
CREATE POLICY "holders read own positions" ON public.vote_member_positions
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (
      public.is_own_holder_key(auth.uid(), holder_key)
      AND EXISTS (SELECT 1 FROM public.votes v WHERE v.id = vote_id AND public.is_property_owner(auth.uid(), v.property_id))
    )
  );
