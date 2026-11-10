-- Liveness: confirms that a real person is present and that the ID document is theirs.
-- One row per attempt per Account Member; every attempt is kept. Run once in the Supabase
-- SQL editor, AFTER account-members.sql. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.member_liveness_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_member_id uuid NOT NULL REFERENCES public.account_members(id),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
  id_document_ref text NOT NULL,
  selfie_url text NOT NULL,
  provider text NOT NULL DEFAULT 'simulated',
  status text NOT NULL,
  reason_code text,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_liveness_status_check CHECK (status IN ('passed', 'failed', 'inconclusive', 'pending')),
  CONSTRAINT member_liveness_checked_check CHECK ((status = 'pending') = (checked_at IS NULL)),
  CONSTRAINT member_liveness_reason_check CHECK (status <> 'passed' OR reason_code IS NULL)
);
CREATE INDEX IF NOT EXISTS member_liveness_member_idx ON public.member_liveness_checks (account_member_id, created_at);
CREATE INDEX IF NOT EXISTS member_liveness_account_idx ON public.member_liveness_checks (buyer_account_id);

-- The member is an active member of that account.
CREATE OR REPLACE FUNCTION public.member_liveness_guard()
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
DROP TRIGGER IF EXISTS member_liveness_guard ON public.member_liveness_checks;
CREATE TRIGGER member_liveness_guard BEFORE INSERT ON public.member_liveness_checks
  FOR EACH ROW EXECUTE FUNCTION public.member_liveness_guard();

-- Attempts are kept as they were: a 'pending' attempt may be resolved once, nothing else changes, nothing is deleted.
CREATE OR REPLACE FUNCTION public.member_liveness_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Liveness attempts are never deleted.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'pending'
     AND (to_jsonb(NEW) - 'status' - 'reason_code' - 'checked_at') = (to_jsonb(OLD) - 'status' - 'reason_code' - 'checked_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A liveness attempt can''t be changed. Take a new one instead.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS member_liveness_immutable ON public.member_liveness_checks;
CREATE TRIGGER member_liveness_immutable BEFORE UPDATE OR DELETE ON public.member_liveness_checks
  FOR EACH ROW EXECUTE FUNCTION public.member_liveness_immutable();

-- Read-only for signed-in users: the server runs the check and writes the result.
REVOKE ALL ON public.member_liveness_checks FROM anon, authenticated;
GRANT SELECT ON public.member_liveness_checks TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.member_liveness_checks TO service_role;
REVOKE DELETE, TRUNCATE ON public.member_liveness_checks FROM service_role;
ALTER TABLE public.member_liveness_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "buyers and admins read liveness checks" ON public.member_liveness_checks;
CREATE POLICY "buyers and admins read liveness checks" ON public.member_liveness_checks
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = buyer_account_id AND b.auth_user_id = auth.uid())
  );

-- Selfies: a private bucket, each buyer writing and reading only their own folder.
INSERT INTO storage.buckets (id, name, public) VALUES ('liveness-selfies', 'liveness-selfies', false)
  ON CONFLICT (id) DO NOTHING;
DROP POLICY IF EXISTS "Buyers upload own liveness selfies" ON storage.objects;
CREATE POLICY "Buyers upload own liveness selfies" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'liveness-selfies' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "Buyers view own liveness selfies" ON storage.objects;
CREATE POLICY "Buyers view own liveness selfies" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'liveness-selfies' AND (storage.foldername(name))[1] = auth.uid()::text);
