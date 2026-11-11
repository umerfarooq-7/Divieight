-- The Eligibility Check wording change: the adverse-action notice (admin action only) and the
-- Hybrid Exit seller's Block 4 declaration. Run once in the Supabase SQL editor, AFTER
-- eligibility-declarations.sql. Safe to re-run.
--
-- Nothing here deletes or rewrites old data: the old Block 4 consent rows stay as 'legacy' records.

-- ---------------------------------------------------------------------------
-- Adverse-action notices. No consumer report is obtained in the ordinary course. If the Question 5
-- authorization is ever exercised and divieight then acts on information in the report, an admin
-- issues one of these. It names the action and the consumer reporting agency. The report itself is
-- never supplied. There is no automatic trigger.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.adverse_action_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_member_id uuid NOT NULL REFERENCES public.account_members(id),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
  declaration_id uuid NOT NULL REFERENCES public.eligibility_declarations(id),
  action_statement text NOT NULL CHECK (length(btrim(action_statement)) > 0),
  agency_name text NOT NULL CHECK (length(btrim(agency_name)) > 0),
  agency_address text NOT NULL CHECK (length(btrim(agency_address)) > 0),
  agency_phone text NOT NULL CHECK (length(btrim(agency_phone)) > 0),
  agency_website text,
  rendered_text text NOT NULL,
  document_hash text NOT NULL CHECK (document_hash ~ '^sha256_[0-9a-f]{64}$'),
  -- The admin confirms a report was obtained under the Q5 authorization and divieight acted on it.
  report_obtained_attested boolean NOT NULL CHECK (report_obtained_attested),
  issued_by uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adverse_action_notices_member_idx ON public.adverse_action_notices (account_member_id, issued_at);

-- ---------------------------------------------------------------------------
-- Hybrid Exit sellers' Block 4 (the same declaration every buyer makes). Full Exit sellers have no
-- eligibility check: the database refuses a declaration from a seller who isn't retaining shares.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.seller_eligibility_declarations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES public.sellers(id),
  standard_version text NOT NULL,
  answers jsonb NOT NULL,
  rendered_text_snapshot text NOT NULL,
  declaration_hash text NOT NULL CHECK (declaration_hash ~ '^sha256_[0-9a-f]{64}$'),
  declared_at timestamptz NOT NULL DEFAULT now(),
  signed_name text NOT NULL CHECK (length(btrim(signed_name)) > 0),
  attested_personally boolean NOT NULL CHECK (attested_personally),
  ip text,
  user_agent text,
  supersedes_id uuid REFERENCES public.seller_eligibility_declarations(id),
  status text NOT NULL CHECK (status IN ('incomplete', 'complete', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_declaration_answers_check CHECK (
    jsonb_typeof(answers) = 'object'
    AND (answers - 'q1' - 'q2' - 'q3' - 'q4' - 'q5' - 'q6') = '{}'::jsonb
    AND answers->>'q1' IN ('yes','no') AND answers->>'q2' IN ('yes','no') AND answers->>'q3' IN ('yes','no')
    AND answers->>'q4' IN ('yes','no') AND answers->>'q5' IN ('yes','no') AND answers->>'q6' IN ('yes','no')
  )
);
CREATE INDEX IF NOT EXISTS seller_eligibility_seller_idx ON public.seller_eligibility_declarations (seller_id, declared_at);
CREATE UNIQUE INDEX IF NOT EXISTS seller_eligibility_one_current ON public.seller_eligibility_declarations (seller_id) WHERE status IN ('incomplete', 'complete');
CREATE UNIQUE INDEX IF NOT EXISTS seller_eligibility_one_correction ON public.seller_eligibility_declarations (supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.seller_declaration_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prev_row public.seller_eligibility_declarations%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sellers s WHERE s.id = NEW.seller_id AND s.exit_type = 'hybrid_exit') THEN
    RAISE EXCEPTION 'Only a seller who retains shares makes this declaration. Full Exit sellers have no eligibility check.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.declaration_hash <> 'sha256_' || encode(sha256(convert_to(NEW.rendered_text_snapshot, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'The declaration hash does not match its text.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'superseded' THEN
    RAISE EXCEPTION 'A declaration is recorded as made; it becomes superseded only when corrected.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> (CASE WHEN NEW.answers->>'q5' = 'yes' THEN 'complete' ELSE 'incomplete' END) THEN
    RAISE EXCEPTION 'A declaration is complete only with the Question 5 authorization.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO prev_row FROM public.seller_eligibility_declarations WHERE id = NEW.supersedes_id FOR UPDATE;
    IF NOT FOUND OR prev_row.seller_id <> NEW.seller_id OR prev_row.status NOT IN ('incomplete', 'complete') THEN
      RAISE EXCEPTION 'A correction must replace this seller''s current declaration.' USING ERRCODE = 'unique_violation';
    END IF;
    PERFORM set_config('divieight.seller_superseding', NEW.supersedes_id::text, true);
    UPDATE public.seller_eligibility_declarations SET status = 'superseded' WHERE id = NEW.supersedes_id;
    PERFORM set_config('divieight.seller_superseding', '', true);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS seller_declaration_insert_guard ON public.seller_eligibility_declarations;
CREATE TRIGGER seller_declaration_insert_guard BEFORE INSERT ON public.seller_eligibility_declarations
  FOR EACH ROW EXECUTE FUNCTION public.seller_declaration_insert_guard();

CREATE OR REPLACE FUNCTION public.seller_declaration_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Eligibility declarations are never deleted.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('incomplete', 'complete') AND NEW.status = 'superseded'
     AND current_setting('divieight.seller_superseding', true) = OLD.id::text
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'An eligibility declaration can''t be changed. Submit a correction instead.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS seller_declaration_immutable ON public.seller_eligibility_declarations;
CREATE TRIGGER seller_declaration_immutable BEFORE UPDATE OR DELETE ON public.seller_eligibility_declarations
  FOR EACH ROW EXECUTE FUNCTION public.seller_declaration_immutable();

-- Notices never change either.
CREATE OR REPLACE FUNCTION public.adverse_action_notice_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Adverse-action notices are append-only.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS adverse_action_notice_append_only ON public.adverse_action_notices;
CREATE TRIGGER adverse_action_notice_append_only BEFORE UPDATE OR DELETE ON public.adverse_action_notices
  FOR EACH ROW EXECUTE FUNCTION public.adverse_action_notice_append_only();

-- The notice's member is on the notice's account.
CREATE OR REPLACE FUNCTION public.adverse_action_notice_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.id = NEW.account_member_id AND m.buyer_account_id = NEW.buyer_account_id) THEN
    RAISE EXCEPTION 'That member isn''t on this account.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS adverse_action_notice_guard ON public.adverse_action_notices;
CREATE TRIGGER adverse_action_notice_guard BEFORE INSERT ON public.adverse_action_notices
  FOR EACH ROW EXECUTE FUNCTION public.adverse_action_notice_guard();

-- Access: written by the server; read by the member's account, admins, and (for a seller's own declarations) the seller.
REVOKE ALL ON public.adverse_action_notices, public.seller_eligibility_declarations FROM anon, authenticated;
GRANT SELECT ON public.adverse_action_notices, public.seller_eligibility_declarations TO authenticated;
GRANT SELECT, INSERT ON public.adverse_action_notices TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.seller_eligibility_declarations TO service_role;
REVOKE UPDATE, DELETE, TRUNCATE ON public.adverse_action_notices FROM service_role;
REVOKE DELETE, TRUNCATE ON public.seller_eligibility_declarations FROM service_role;
ALTER TABLE public.adverse_action_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_eligibility_declarations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "buyers and admins read adverse action notices" ON public.adverse_action_notices;
CREATE POLICY "buyers and admins read adverse action notices" ON public.adverse_action_notices
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = buyer_account_id AND b.auth_user_id = auth.uid())
  );
DROP POLICY IF EXISTS "sellers and admins read seller declarations" ON public.seller_eligibility_declarations;
CREATE POLICY "sellers and admins read seller declarations" ON public.seller_eligibility_declarations
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR seller_id = auth.uid());
