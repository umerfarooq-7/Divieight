-- Co-buyer links. Run once in the Supabase SQL editor, after account-members.sql. Safe to re-run.
--
-- Two buyers, each with their OWN account, login, onboarding, payment and Golden Ticket, who can choose to reserve a share
-- together. This table is only the link between the two accounts: who invited whom, and whether it was accepted.
-- (The older "second member on one account" is no longer offered to new buyers; existing rows are untouched.)
--
-- Rules, enforced here whoever writes:
--  * a link is between two different accounts
--  * one OPEN link (invited or active) per inviting account
--  * an account is the other side of at most one ACTIVE link
--  * the invitation token is stored only as a hash
--  * clients can read their own links; only divieight's server (service role) writes them

CREATE TABLE IF NOT EXISTS public.co_buyer_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  invitee_account_id uuid REFERENCES public.buyer_accounts(id) ON DELETE SET NULL,
  invitee_name text NOT NULL,
  invitee_email text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'invited',
  invited_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  ended_at timestamptz,
  ended_by uuid,
  CONSTRAINT co_buyer_links_status_check CHECK (status IN ('invited', 'active', 'declined', 'revoked')),
  CONSTRAINT co_buyer_links_two_accounts_check CHECK (invitee_account_id IS NULL OR invitee_account_id <> inviter_account_id),
  CONSTRAINT co_buyer_links_active_has_invitee CHECK (status <> 'active' OR invitee_account_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS co_buyer_links_one_open_per_inviter
  ON public.co_buyer_links (inviter_account_id) WHERE status IN ('invited', 'active');
CREATE UNIQUE INDEX IF NOT EXISTS co_buyer_links_one_active_per_invitee
  ON public.co_buyer_links (invitee_account_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS co_buyer_links_invitee_email ON public.co_buyer_links (lower(invitee_email)) WHERE status = 'invited';
CREATE INDEX IF NOT EXISTS co_buyer_links_token ON public.co_buyer_links (token_hash);

ALTER TABLE public.co_buyer_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Buyers read their own co-buyer links" ON public.co_buyer_links;
CREATE POLICY "Buyers read their own co-buyer links" ON public.co_buyer_links FOR SELECT TO authenticated
  USING (
    inviter_account_id IN (SELECT id FROM public.buyer_accounts WHERE auth_user_id = auth.uid())
    OR invitee_account_id IN (SELECT id FROM public.buyer_accounts WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Admins read co-buyer links" ON public.co_buyer_links;
CREATE POLICY "Admins read co-buyer links" ON public.co_buyer_links FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

REVOKE ALL ON public.co_buyer_links FROM anon, authenticated;
GRANT SELECT ON public.co_buyer_links TO authenticated;
GRANT ALL ON public.co_buyer_links TO service_role;
