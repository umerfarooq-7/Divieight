-- Co-buyers as limited sub-accounts. Run once in the Supabase SQL editor, after account-members.sql. Safe to re-run.
--
-- A co-buyer is an Account Member of the main buyer's own account who has a login of their own. They do their own identity, liveness, Eligibility
-- Standard, declaration, hold harmless, W-9 and Priority Reservation Agreement, and pay their own enrollment fee. They see only what is theirs to
-- do or sign, and only for the shares the main buyer chose to buy with them. The main buyer alone reserves, pays, and holds the agent, the money
-- and everything else.
--
-- Rules, enforced here whoever writes:
--  * a login belongs to at most one active member
--  * a member's login, invitation and join date can only be written by divieight's server (the service role), never from the browser
--  * one co-buyer per share (a reservation), named once
--  * a co-buyer reads their own member row; the account holder reads all of theirs; nobody else reads any

ALTER TABLE public.account_members
  ADD COLUMN IF NOT EXISTS auth_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invite_token_hash text,
  ADD COLUMN IF NOT EXISTS invited_at timestamptz,
  ADD COLUMN IF NOT EXISTS joined_at timestamptz,
  ADD COLUMN IF NOT EXISTS enrollment_paid_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS account_members_one_login_idx
  ON public.account_members (auth_user_id) WHERE auth_user_id IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS account_members_invite_idx
  ON public.account_members (invite_token_hash) WHERE invite_token_hash IS NOT NULL;

-- Only divieight's server writes who can sign in as a member.
CREATE OR REPLACE FUNCTION public.account_members_login_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.is_platform_writer() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.auth_user_id IS NOT NULL OR NEW.invite_token_hash IS NOT NULL OR NEW.joined_at IS NOT NULL OR NEW.enrollment_paid_at IS NOT NULL THEN
      RAISE EXCEPTION 'A member''s login can only be set up by divieight.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id
     OR NEW.invite_token_hash IS DISTINCT FROM OLD.invite_token_hash
     OR NEW.invited_at IS DISTINCT FROM OLD.invited_at
     OR NEW.joined_at IS DISTINCT FROM OLD.joined_at
     OR NEW.enrollment_paid_at IS DISTINCT FROM OLD.enrollment_paid_at THEN
    RAISE EXCEPTION 'A member''s login can only be changed by divieight.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS account_members_login_guard ON public.account_members;
CREATE TRIGGER account_members_login_guard BEFORE INSERT OR UPDATE ON public.account_members
  FOR EACH ROW EXECUTE FUNCTION public.account_members_login_guard();

-- A co-buyer reads their own member row (the account holder already reads the account's).
DROP POLICY IF EXISTS "Co-buyers read their own member row" ON public.account_members;
CREATE POLICY "Co-buyers read their own member row" ON public.account_members FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

-- Which share is bought with the co-buyer. Only these shares show up for them.
CREATE TABLE IF NOT EXISTS public.reservation_co_members (
  reservation_id uuid PRIMARY KEY REFERENCES public.pod_reservations (id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts (id) ON DELETE CASCADE,
  account_member_id uuid NOT NULL REFERENCES public.account_members (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reservation_co_members_member_idx ON public.reservation_co_members (account_member_id);
CREATE INDEX IF NOT EXISTS reservation_co_members_property_idx ON public.reservation_co_members (property_id);

ALTER TABLE public.reservation_co_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Buyers read the shares they bought with a co-buyer" ON public.reservation_co_members;
CREATE POLICY "Buyers read the shares they bought with a co-buyer" ON public.reservation_co_members FOR SELECT TO authenticated
  USING (
    buyer_account_id IN (SELECT id FROM public.buyer_accounts WHERE auth_user_id = auth.uid())
    OR account_member_id IN (SELECT id FROM public.account_members WHERE auth_user_id = auth.uid())
  );
DROP POLICY IF EXISTS "Admins read co-buyer shares" ON public.reservation_co_members;
CREATE POLICY "Admins read co-buyer shares" ON public.reservation_co_members FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

REVOKE ALL ON public.reservation_co_members FROM anon, authenticated;
GRANT SELECT ON public.reservation_co_members TO authenticated;
GRANT ALL ON public.reservation_co_members TO service_role;

-- The co-buyer's own enrollment fee is recorded against them, not against the account's priority rank.
ALTER TABLE public.buyer_enrollment_payments
  ADD COLUMN IF NOT EXISTS account_member_id uuid REFERENCES public.account_members (id) ON DELETE SET NULL;
