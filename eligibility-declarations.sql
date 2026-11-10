-- Block 4: Eligibility Declaration and Authorization. Run once in the Supabase SQL editor,
-- AFTER account-members.sql and eligibility-acknowledgements.sql. Safe to re-run.
--
-- One row per submission per Account Member. A correction is a NEW row naming the one it
-- replaces (supersedes_id); the earlier row is marked 'superseded' and is otherwise never
-- changed or deleted. rendered_text_snapshot is the exact text the member declared, and
-- declaration_hash is 'sha256_' + hex SHA-256 of that text: what a person swore to can be
-- reproduced, and checked, years later. No consumer report is requested from this flow.
--
-- The old Block 4 ("Background Check Consent" checkbox) is kept: its columns on
-- account_members are untouched, and each member who gave it gets one 'legacy' row here.

CREATE TABLE IF NOT EXISTS public.eligibility_declarations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_member_id uuid NOT NULL REFERENCES public.account_members(id),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
  standard_version text NOT NULL,
  answers jsonb,
  rendered_text_snapshot text NOT NULL,
  declaration_hash text NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),
  signed_name text,
  attested_personally boolean NOT NULL DEFAULT false,
  ip text,
  user_agent text,
  supersedes_id uuid REFERENCES public.eligibility_declarations(id),
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT eligibility_declarations_status_check CHECK (status IN ('incomplete', 'complete', 'superseded', 'legacy')),
  CONSTRAINT eligibility_declarations_hash_check CHECK (declaration_hash ~ '^sha256_[0-9a-f]{64}$'),
  -- A declaration (not a legacy consent) always has six Yes/No answers, a signature and the personal attestation.
  CONSTRAINT eligibility_declarations_shape_check CHECK (
    status = 'legacy' OR (
      answers IS NOT NULL
      AND jsonb_typeof(answers) = 'object'
      AND (answers - 'q1' - 'q2' - 'q3' - 'q4' - 'q5' - 'q6') = '{}'::jsonb
      AND answers->>'q1' IN ('yes','no') AND answers->>'q2' IN ('yes','no') AND answers->>'q3' IN ('yes','no')
      AND answers->>'q4' IN ('yes','no') AND answers->>'q5' IN ('yes','no') AND answers->>'q6' IN ('yes','no')
      AND attested_personally
      AND length(btrim(coalesce(signed_name, ''))) > 0
    )
  )
);
CREATE INDEX IF NOT EXISTS eligibility_declarations_account_idx ON public.eligibility_declarations (buyer_account_id);
CREATE INDEX IF NOT EXISTS eligibility_declarations_member_idx ON public.eligibility_declarations (account_member_id, declared_at);
-- At most one current (incomplete or complete) declaration per member.
CREATE UNIQUE INDEX IF NOT EXISTS eligibility_declarations_one_current
  ON public.eligibility_declarations (account_member_id) WHERE status IN ('incomplete', 'complete');
-- A record is corrected at most once.
CREATE UNIQUE INDEX IF NOT EXISTS eligibility_declarations_one_correction
  ON public.eligibility_declarations (supersedes_id) WHERE supersedes_id IS NOT NULL;

-- Inserts: the member is active in that account, the hash is the hash of the snapshot, the status
-- follows Q5, and a correction supersedes the member's current record in the same statement.
CREATE OR REPLACE FUNCTION public.eligibility_declaration_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prev_row public.eligibility_declarations%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.account_members m
    WHERE m.id = NEW.account_member_id AND m.buyer_account_id = NEW.buyer_account_id
      AND (m.status = 'active' OR NEW.status = 'legacy')
  ) THEN
    RAISE EXCEPTION 'That member isn''t an active member of this account.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.declaration_hash <> 'sha256_' || encode(sha256(convert_to(NEW.rendered_text_snapshot, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'The declaration hash does not match its text.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'superseded' THEN
    RAISE EXCEPTION 'A declaration is recorded as made; it becomes superseded only when corrected.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'legacy' AND NEW.status <> (CASE WHEN NEW.answers->>'q5' = 'yes' THEN 'complete' ELSE 'incomplete' END) THEN
    RAISE EXCEPTION 'A declaration is complete only with the Question 5 authorization.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO prev_row FROM public.eligibility_declarations WHERE id = NEW.supersedes_id FOR UPDATE;
    IF NOT FOUND OR prev_row.account_member_id <> NEW.account_member_id OR prev_row.status NOT IN ('incomplete', 'complete') THEN
      RAISE EXCEPTION 'A correction must replace this member''s current declaration.' USING ERRCODE = 'unique_violation';
    END IF;
    PERFORM set_config('divieight.superseding', NEW.supersedes_id::text, true);
    UPDATE public.eligibility_declarations SET status = 'superseded' WHERE id = NEW.supersedes_id;
    PERFORM set_config('divieight.superseding', '', true);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS eligibility_declaration_insert_guard ON public.eligibility_declarations;
CREATE TRIGGER eligibility_declaration_insert_guard BEFORE INSERT ON public.eligibility_declarations
  FOR EACH ROW EXECUTE FUNCTION public.eligibility_declaration_insert_guard();

-- Records never change, except current -> superseded when a correction is inserted, and nothing else on the row.
CREATE OR REPLACE FUNCTION public.eligibility_declaration_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Eligibility declarations are never deleted.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only the insert of the correcting record (insert guard above) may mark this one superseded.
  IF OLD.status IN ('incomplete', 'complete') AND NEW.status = 'superseded'
     AND current_setting('divieight.superseding', true) = OLD.id::text
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An eligibility declaration can''t be changed. Submit a correction instead.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS eligibility_declaration_immutable ON public.eligibility_declarations;
CREATE TRIGGER eligibility_declaration_immutable BEFORE UPDATE OR DELETE ON public.eligibility_declarations
  FOR EACH ROW EXECUTE FUNCTION public.eligibility_declaration_immutable();

-- Read-only for signed-in users: the server writes. Nobody deletes.
REVOKE ALL ON public.eligibility_declarations FROM anon, authenticated;
GRANT SELECT ON public.eligibility_declarations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.eligibility_declarations TO service_role;
REVOKE DELETE, TRUNCATE ON public.eligibility_declarations FROM service_role;
ALTER TABLE public.eligibility_declarations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "buyers and admins read eligibility declarations" ON public.eligibility_declarations;
CREATE POLICY "buyers and admins read eligibility declarations" ON public.eligibility_declarations
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = buyer_account_id AND b.auth_user_id = auth.uid())
  );

-- The old Block 4, kept as 'legacy': one row per member who gave the old checkbox consent.
-- The account_members columns it came from (fcra_consent_at, background_check_result,
-- background_check_at) are left exactly as they are.
INSERT INTO public.eligibility_declarations
  (account_member_id, buyer_account_id, standard_version, answers, rendered_text_snapshot, declaration_hash, declared_at, attested_personally, status)
SELECT m.id, m.buyer_account_id, 'legacy-background-check-consent', NULL, t.txt,
       'sha256_' || encode(sha256(convert_to(t.txt, 'UTF8')), 'hex'), m.fcra_consent_at, false, 'legacy'
FROM public.account_members m
CROSS JOIN LATERAL (SELECT
  'Legacy Block 4 — Background Check Consent (before the Eligibility Declaration and Authorization)' || chr(10) ||
  'I authorize divieight to obtain a consumer report about me for eligibility purposes, now and periodically thereafter.' || chr(10) ||
  'Consent given: ' || to_char(m.fcra_consent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || chr(10) ||
  'Recorded result at migration: ' || coalesce(m.background_check_result, 'none') AS txt) t
WHERE m.fcra_consent_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.eligibility_declarations d WHERE d.account_member_id = m.id AND d.status = 'legacy');
