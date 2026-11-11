-- Know Your Owner (KYO): data-rights correction requests. Run once in the Supabase SQL editor, AFTER
-- member-steps.sql and eligibility-wording.sql. Safe to re-run.
--
-- A member can see their own KYO data and ask for a correction. This table only records the
-- request and how it was handled. Nothing here changes the KYO retention periods, the PII
-- Sub-Vault or the Audit Vault.

CREATE TABLE IF NOT EXISTS public.kyo_correction_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_member_id uuid NOT NULL REFERENCES public.account_members(id),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
  field text NOT NULL CHECK (field IN ('full_name', 'date_of_birth', 'address', 'id_document_number', 'email', 'phone', 'w9', 'other')),
  requested_change text NOT NULL CHECK (length(btrim(requested_change)) > 0 AND length(requested_change) <= 2000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kyo_correction_resolved_check CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS kyo_correction_member_idx ON public.kyo_correction_requests (account_member_id, created_at);
CREATE INDEX IF NOT EXISTS kyo_correction_open_idx ON public.kyo_correction_requests (status) WHERE status = 'open';

-- The member is an active member of that account.
CREATE OR REPLACE FUNCTION public.kyo_correction_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.account_members m
    WHERE m.id = NEW.account_member_id AND m.buyer_account_id = NEW.buyer_account_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'That member isn''t an active member of this account.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'open' THEN
    RAISE EXCEPTION 'A request starts open.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS kyo_correction_guard ON public.kyo_correction_requests;
CREATE TRIGGER kyo_correction_guard BEFORE INSERT ON public.kyo_correction_requests
  FOR EACH ROW EXECUTE FUNCTION public.kyo_correction_guard();

-- A request is never edited or deleted; an open one is resolved once, with a note.
CREATE OR REPLACE FUNCTION public.kyo_correction_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Correction requests are never deleted.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'resolved'
     AND (to_jsonb(NEW) - 'status' - 'resolution_note' - 'resolved_by' - 'resolved_at') = (to_jsonb(OLD) - 'status' - 'resolution_note' - 'resolved_by' - 'resolved_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A correction request can''t be changed.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS kyo_correction_immutable ON public.kyo_correction_requests;
CREATE TRIGGER kyo_correction_immutable BEFORE UPDATE OR DELETE ON public.kyo_correction_requests
  FOR EACH ROW EXECUTE FUNCTION public.kyo_correction_immutable();

-- Written by the server; read by the member's account and by admins.
REVOKE ALL ON public.kyo_correction_requests FROM anon, authenticated;
GRANT SELECT ON public.kyo_correction_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.kyo_correction_requests TO service_role;
REVOKE DELETE, TRUNCATE ON public.kyo_correction_requests FROM service_role;
ALTER TABLE public.kyo_correction_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "buyers and admins read kyo correction requests" ON public.kyo_correction_requests;
CREATE POLICY "buyers and admins read kyo correction requests" ON public.kyo_correction_requests
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = buyer_account_id AND b.auth_user_id = auth.uid())
  );
