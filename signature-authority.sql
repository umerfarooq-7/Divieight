-- Stronger signatures and documented authority. Run once in the Supabase SQL editor, AFTER
-- member-steps.sql and the other Month 5 files. Safe to re-run.
--
-- 1. Every signing records the acting member, the typed value, the time, the IP, the browser and the
--    document hash (new columns below).
-- 2. member_authority_grants: one Account Member authorizes another, on an allowed list of scopes only.
-- 3. A signing done under authority must point at a live grant. The database itself enforces this, so
--    a revoked grant, the wrong scope or the wrong people can't be used even by a buggy caller.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.member_authority_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
  grantor_member_id uuid NOT NULL REFERENCES public.account_members(id),
  grantee_member_id uuid NOT NULL REFERENCES public.account_members(id),
  scope text[] NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  grantor_typed_name text NOT NULL CHECK (length(btrim(grantor_typed_name)) > 0),
  document_hash text NOT NULL CHECK (document_hash ~ '^sha256_[0-9a-f]{64}$'),
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_authority_not_self CHECK (grantor_member_id <> grantee_member_id),
  -- ONLY these scopes can exist. Block 4, ID scan, liveness, Block 1, Block 2, Hold Harmless and W-9 are not
  -- among them, so they can't be written here by anyone.
  CONSTRAINT member_authority_scope_allowed CHECK (
    cardinality(scope) > 0
    AND scope <@ ARRAY['pra', 'due_diligence_ack', 'authorizations', 'block3', 'closing_docs']::text[]
  ),
  CONSTRAINT member_authority_revoked_after CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE INDEX IF NOT EXISTS member_authority_account_idx ON public.member_authority_grants (buyer_account_id);
-- One live grant per pair: to change the scope, revoke and grant again.
CREATE UNIQUE INDEX IF NOT EXISTS member_authority_one_live
  ON public.member_authority_grants (grantor_member_id, grantee_member_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION public.member_authority_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'A grant starts live; it is revoked later.' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM public.account_members m
        WHERE m.id IN (NEW.grantor_member_id, NEW.grantee_member_id) AND m.buyer_account_id = NEW.buyer_account_id AND m.status = 'active') <> 2 THEN
    RAISE EXCEPTION 'Both members must be active members of this account.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS member_authority_guard ON public.member_authority_grants;
CREATE TRIGGER member_authority_guard BEFORE INSERT ON public.member_authority_grants
  FOR EACH ROW EXECUTE FUNCTION public.member_authority_guard();

-- A grant never changes, except that a live one is revoked, once. Nothing is deleted.
CREATE OR REPLACE FUNCTION public.member_authority_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Authority grants are never deleted.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND (to_jsonb(NEW) - 'revoked_at') = (to_jsonb(OLD) - 'revoked_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An authority grant can''t be changed. Revoke it and grant again.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS member_authority_immutable ON public.member_authority_grants;
CREATE TRIGGER member_authority_immutable BEFORE UPDATE OR DELETE ON public.member_authority_grants
  FOR EACH ROW EXECUTE FUNCTION public.member_authority_immutable();

REVOKE ALL ON public.member_authority_grants FROM anon, authenticated;
GRANT SELECT ON public.member_authority_grants TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.member_authority_grants TO service_role;
REVOKE DELETE, TRUNCATE ON public.member_authority_grants FROM service_role;
ALTER TABLE public.member_authority_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "buyers and admins read authority grants" ON public.member_authority_grants;
CREATE POLICY "buyers and admins read authority grants" ON public.member_authority_grants
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = buyer_account_id AND b.auth_user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Every signing record: who acted, for whom, under which grant, from where
-- ---------------------------------------------------------------------------
ALTER TABLE public.signed_documents
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS acted_by_member_id uuid REFERENCES public.account_members(id),
  ADD COLUMN IF NOT EXISTS on_behalf_of_member_id uuid REFERENCES public.account_members(id),
  ADD COLUMN IF NOT EXISTS authority_grant_id uuid REFERENCES public.member_authority_grants(id);
ALTER TABLE public.authorization_responses
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS document_hash text,
  ADD COLUMN IF NOT EXISTS acted_by_member_id uuid REFERENCES public.account_members(id),
  ADD COLUMN IF NOT EXISTS authority_grant_id uuid REFERENCES public.member_authority_grants(id);
ALTER TABLE public.due_diligence_acknowledgments
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS acted_by_member_id uuid REFERENCES public.account_members(id),
  ADD COLUMN IF NOT EXISTS on_behalf_of_member_id uuid REFERENCES public.account_members(id),
  ADD COLUMN IF NOT EXISTS authority_grant_id uuid REFERENCES public.member_authority_grants(id);
ALTER TABLE public.operating_agreement_signatures
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS acted_by_member_id uuid REFERENCES public.account_members(id),
  ADD COLUMN IF NOT EXISTS on_behalf_of_member_id uuid REFERENCES public.account_members(id),
  ADD COLUMN IF NOT EXISTS authority_grant_id uuid REFERENCES public.member_authority_grants(id);

-- From now on a record made on someone's behalf names the grant (older ad-hoc rows are left as they were).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['signed_documents', 'authorization_responses', 'due_diligence_acknowledgments', 'operating_agreement_signatures'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_authority_named');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (on_behalf_of_member_id IS NULL OR authority_grant_id IS NOT NULL) NOT VALID', t, t || '_authority_named');
  END LOOP;
END $$;

-- The database enforces what a grant allows, whatever the caller does.
CREATE OR REPLACE FUNCTION public.authority_use_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  g public.member_authority_grants%ROWTYPE;
  needed text;
BEGIN
  IF NEW.authority_grant_id IS NULL AND NEW.on_behalf_of_member_id IS NULL THEN
    RETURN NEW; -- an ordinary signing by the member themselves
  END IF;
  IF NEW.authority_grant_id IS NULL OR NEW.on_behalf_of_member_id IS NULL OR NEW.acted_by_member_id IS NULL THEN
    RAISE EXCEPTION 'A signing on someone''s behalf names who acted, for whom, and the authority grant.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'signed_documents' THEN
    IF NEW.document_type <> 'PRA' THEN
      RAISE EXCEPTION 'Authority can never cover this document.' USING ERRCODE = 'check_violation';
    END IF;
    needed := 'pra';
  ELSIF TG_TABLE_NAME = 'authorization_responses' THEN
    needed := 'authorizations';
  ELSIF TG_TABLE_NAME = 'due_diligence_acknowledgments' THEN
    needed := 'due_diligence_ack';
  ELSE
    needed := 'closing_docs';
  END IF;
  SELECT * INTO g FROM public.member_authority_grants WHERE id = NEW.authority_grant_id;
  IF NOT FOUND OR g.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'That authority has been revoked, or doesn''t exist.' USING ERRCODE = 'check_violation';
  END IF;
  IF g.buyer_account_id <> NEW.buyer_account_id OR g.grantor_member_id <> NEW.on_behalf_of_member_id OR g.grantee_member_id <> NEW.acted_by_member_id THEN
    RAISE EXCEPTION 'That authority was not given by this member to this member.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (needed = ANY (g.scope)) THEN
    RAISE EXCEPTION 'That authority doesn''t cover this.' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM public.account_members m WHERE m.id IN (g.grantor_member_id, g.grantee_member_id) AND m.status = 'active') <> 2 THEN
    RAISE EXCEPTION 'Both members must still be active.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['signed_documents', 'authorization_responses', 'due_diligence_acknowledgments', 'operating_agreement_signatures'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_authority_use', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.authority_use_guard()', t || '_authority_use', t);
  END LOOP;
END $$;
