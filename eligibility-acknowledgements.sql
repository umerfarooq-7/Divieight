-- Eligibility Decision Page: "Read the Standard" acknowledgements. Run once in the
-- Supabase SQL editor, AFTER account-members.sql. Safe to re-run.
--
-- This records that a member READ the Participant Eligibility Standard. It is NOT the
-- declaration (Block 4), which is a separate record made under penalty of perjury.

CREATE TABLE IF NOT EXISTS public.eligibility_page_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_member_id uuid NOT NULL REFERENCES public.account_members(id),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  standard_version text NOT NULL,
  page_spec_version text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text,
  -- One row per member per version of the Standard and of the page.
  UNIQUE (account_member_id, standard_version, page_spec_version)
);
CREATE INDEX IF NOT EXISTS eligibility_page_ack_account_idx ON public.eligibility_page_acknowledgements (buyer_account_id);

-- The member must be an active member of that account.
CREATE OR REPLACE FUNCTION public.eligibility_ack_member_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.account_members m
    WHERE m.id = NEW.account_member_id AND m.buyer_account_id = NEW.buyer_account_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'That member isn''t an active member of this account.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS eligibility_ack_member_guard ON public.eligibility_page_acknowledgements;
CREATE TRIGGER eligibility_ack_member_guard BEFORE INSERT OR UPDATE ON public.eligibility_page_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION public.eligibility_ack_member_guard();

-- Read-only for signed-in users: the server writes.
GRANT SELECT ON public.eligibility_page_acknowledgements TO authenticated;
GRANT ALL ON public.eligibility_page_acknowledgements TO service_role;
ALTER TABLE public.eligibility_page_acknowledgements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "buyers and admins read eligibility acknowledgements" ON public.eligibility_page_acknowledgements;
CREATE POLICY "buyers and admins read eligibility acknowledgements" ON public.eligibility_page_acknowledgements
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = buyer_account_id AND b.auth_user_id = auth.uid())
  );
