-- Held-account reminders, the questions-and-rules hash, and authority scope clean-up. Run once in the Supabase SQL editor,
-- AFTER standard-versions.sql, signature-authority.sql, eligibility-results.sql and cron-sweeps.sql. Safe to re-run.
--
--  1. held_followups: the nightly reminder and any snooze, per held member. Only the server reads and writes it.
--  2. standard_versions.rules_hash: the hash of the six questions and the engine's rules the version was published with.
--     The live version gets the hash of the questions and rules in the current release. From then on, changing a question
--     or a rule without publishing a new Standard version stops new declarations ("Questions or rules changed: publish a
--     new Standard version.").
--  3. Documented authority: Block 1 and Block 2 are not things authority can cover. Any grant still carrying them has them
--     removed, and what was removed is recorded. (The table's own check already refuses them, so normally nothing is found.)

-- 1. Held-account follow-ups.
CREATE TABLE IF NOT EXISTS public.held_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_member_id uuid NOT NULL REFERENCES public.account_members(id),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id),
  kind text NOT NULL CHECK (kind IN ('reminder', 'snooze')),
  days_held integer,
  until timestamptz,
  note text,
  admin_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'snooze' OR (until IS NOT NULL AND note IS NOT NULL AND btrim(note) <> ''))
);
CREATE INDEX IF NOT EXISTS held_followups_member_idx ON public.held_followups (account_member_id, created_at DESC);
ALTER TABLE public.held_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.held_followups FROM anon, authenticated;
GRANT ALL ON public.held_followups TO service_role;

-- 2. The questions-and-rules hash.
ALTER TABLE public.standard_versions ADD COLUMN IF NOT EXISTS rules_hash text;
COMMENT ON COLUMN public.standard_versions.rules_hash IS
  'SHA-256 of the six questions and the engine rule set this version was published with (src/lib/standard-rules-hash.ts).';
-- A published version is still never edited. The one thing that may be written to it afterwards is this hash, once, when
-- it has none yet (that is how a version published before the hash existed gets stamped). Once set, it never changes.
CREATE OR REPLACE FUNCTION public.standard_versions_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A Standard version is never deleted.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.rules_hash IS NOT NULL AND NEW.rules_hash IS DISTINCT FROM OLD.rules_hash THEN
    RAISE EXCEPTION 'A Standard version''s rules hash never changes. Publish a new version instead.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'is_live' - 'rules_hash') = (to_jsonb(OLD) - 'is_live' - 'rules_hash') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A published Standard version can''t be edited. Publish a new version instead.' USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Publishing now writes the hash in the same insert, so a new version is stamped from the moment it exists.
DROP FUNCTION IF EXISTS public.publish_standard_version(text, text, uuid);
CREATE OR REPLACE FUNCTION public.publish_standard_version(_version text, _file_url text, _published_by uuid, _rules_hash text DEFAULT NULL)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  live_version text;
  at timestamptz := now();
BEGIN
  IF _version !~ '^[0-9]+\.[0-9]+$' THEN
    RAISE EXCEPTION 'A version looks like 1.2.' USING ERRCODE = 'check_violation';
  END IF;
  -- One publisher at a time.
  PERFORM pg_advisory_xact_lock(hashtext('publish_standard_version'));
  SELECT version INTO live_version FROM public.standard_versions WHERE is_live;
  IF live_version IS NOT NULL AND (string_to_array(_version, '.')::int[]) <= (string_to_array(live_version, '.')::int[]) THEN
    RAISE EXCEPTION 'The new version must be newer than the live version (%).', live_version USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.standard_versions WHERE version = _version) THEN
    RAISE EXCEPTION 'Version % already exists.', _version USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE public.standard_versions SET is_live = false WHERE is_live;
  INSERT INTO public.standard_versions (version, effective_from, is_live, file_url, published_by, rules_hash) VALUES (_version, at, true, _file_url, _published_by, _rules_hash);
  RETURN at;
END;
$$;
REVOKE ALL ON FUNCTION public.publish_standard_version(text, text, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_standard_version(text, text, uuid, text) TO service_role;

-- The live version is stamped with the hash of the questions and rules in the current release.
UPDATE public.standard_versions
SET rules_hash = '48b8dc368a931d299f154ced3c46fadb9d40d313bd00e31042836f855610deb2'
WHERE is_live AND rules_hash IS NULL;

-- 3. Authority scopes: keep a record of anything removed.
CREATE TABLE IF NOT EXISTS public.member_authority_scope_removals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL,
  removed_scopes text[] NOT NULL,
  scope_before text[] NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_authority_scope_removals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_authority_scope_removals FROM anon, authenticated;
GRANT ALL ON public.member_authority_scope_removals TO service_role;

DO $$
DECLARE g record;
BEGIN
  -- The scope check forbids these, so on a database that has the check there is nothing to find. If a grant did carry
  -- one (an older version of the table), the scope is removed here, the grant otherwise stays, and the removal is recorded.
  FOR g IN
    SELECT id, scope FROM public.member_authority_grants WHERE scope && ARRAY['block1', 'block2']::text[]
  LOOP
    INSERT INTO public.member_authority_scope_removals (grant_id, removed_scopes, scope_before)
    VALUES (g.id, ARRAY(SELECT s FROM unnest(g.scope) s WHERE s IN ('block1', 'block2')), g.scope);
    UPDATE public.member_authority_grants SET scope = ARRAY(SELECT s FROM unnest(g.scope) s WHERE s NOT IN ('block1', 'block2')) WHERE id = g.id;
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL; -- signature-authority.sql hasn't been run: nothing to clean
END $$;
