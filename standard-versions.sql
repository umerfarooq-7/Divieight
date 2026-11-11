-- The Participant Eligibility Standard as a versioned document. Run once in the Supabase SQL editor,
-- AFTER eligibility-declarations.sql, eligibility-results.sql and eligibility-wording.sql. Safe to re-run.
--
-- Rules the database enforces:
--  * Exactly one version is live at any time (a unique index stops two; a deferred check stops none).
--  * A version is never edited or deleted once published; only its live flag moves, and only through
--    publish_standard_version(), which switches the live version in one transaction.
--  * Every declaration records the version that was live when it was made.
--  * Every result is tied to the version of the declaration it was determined on. Publishing a new version
--    never re-measures anyone: it applies only to declarations made after it takes effect.

CREATE TABLE IF NOT EXISTS public.standard_versions (
  version text PRIMARY KEY CHECK (version ~ '^[0-9]+\.[0-9]+$'),
  effective_from timestamptz NOT NULL,
  is_live boolean NOT NULL DEFAULT false,
  -- The document, named like Participant_Eligibility_Standard_v1.1 (with its extension).
  file_url text NOT NULL,
  published_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT standard_versions_file_name CHECK (position('Participant_Eligibility_Standard_v' || version in file_url) > 0)
);

-- At most one live version. (An expression index on a constant: every live row collides with every other.)
CREATE UNIQUE INDEX IF NOT EXISTS standard_versions_one_live ON public.standard_versions ((true)) WHERE is_live;

-- At least one: checked when the transaction commits, so publish can switch the flag inside one transaction.
CREATE OR REPLACE FUNCTION public.standard_versions_exactly_one_live()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (SELECT count(*) FROM public.standard_versions WHERE is_live) <> 1 THEN
    RAISE EXCEPTION 'Exactly one Participant Eligibility Standard version must be live.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS standard_versions_exactly_one_live ON public.standard_versions;
CREATE CONSTRAINT TRIGGER standard_versions_exactly_one_live AFTER INSERT OR UPDATE OR DELETE ON public.standard_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.standard_versions_exactly_one_live();

-- A published version is never changed or deleted: only the live flag moves.
CREATE OR REPLACE FUNCTION public.standard_versions_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A Standard version is never deleted.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'is_live') = (to_jsonb(OLD) - 'is_live') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A published Standard version can''t be edited. Publish a new version instead.' USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER IF EXISTS standard_versions_immutable ON public.standard_versions;
CREATE TRIGGER standard_versions_immutable BEFORE UPDATE OR DELETE ON public.standard_versions
  FOR EACH ROW EXECUTE FUNCTION public.standard_versions_immutable();

-- Publish a new version: it becomes the live one, and the one before stops being live, in one transaction.
-- It must be newer than the live version. Nothing is re-measured: existing declarations and results keep the
-- version they were made under.
CREATE OR REPLACE FUNCTION public.publish_standard_version(_version text, _file_url text, _published_by uuid)
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
  INSERT INTO public.standard_versions (version, effective_from, is_live, file_url, published_by) VALUES (_version, at, true, _file_url, _published_by);
  RETURN at;
END;
$$;
REVOKE ALL ON FUNCTION public.publish_standard_version(text, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_standard_version(text, text, uuid) TO service_role;

-- Access: everyone signed in can read which version is live; only the server publishes.
REVOKE ALL ON public.standard_versions FROM anon, authenticated;
GRANT SELECT ON public.standard_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.standard_versions TO service_role;
REVOKE DELETE, TRUNCATE ON public.standard_versions FROM service_role;
ALTER TABLE public.standard_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "signed-in users read standard versions" ON public.standard_versions;
CREATE POLICY "signed-in users read standard versions" ON public.standard_versions FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- Declarations and results are tied to a version, in the database as well as the app.
-- ---------------------------------------------------------------------------
-- A new declaration records the version that is live when it is made.
CREATE OR REPLACE FUNCTION public.declaration_uses_live_standard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE live_version text;
BEGIN
  IF TG_TABLE_NAME = 'eligibility_declarations' AND NEW.status = 'legacy' THEN
    RETURN NEW; -- the old Block 4 consent isn't a declaration under any version
  END IF;
  SELECT version INTO live_version FROM public.standard_versions WHERE is_live;
  IF live_version IS NOT NULL AND NEW.standard_version <> live_version THEN
    RAISE EXCEPTION 'A declaration is made under the Standard that is live now (%), not %.', live_version, NEW.standard_version USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS declaration_uses_live_standard ON public.eligibility_declarations;
CREATE TRIGGER declaration_uses_live_standard BEFORE INSERT ON public.eligibility_declarations
  FOR EACH ROW EXECUTE FUNCTION public.declaration_uses_live_standard();
DO $$
BEGIN
  IF to_regclass('public.seller_eligibility_declarations') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS declaration_uses_live_standard ON public.seller_eligibility_declarations';
    EXECUTE 'CREATE TRIGGER declaration_uses_live_standard BEFORE INSERT ON public.seller_eligibility_declarations FOR EACH ROW EXECUTE FUNCTION public.declaration_uses_live_standard()';
  END IF;
END $$;

-- A result is tied to the version of the declaration it was determined on, so a recompute after a new
-- version goes live never moves an existing participant to it.
CREATE OR REPLACE FUNCTION public.result_matches_declaration_standard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE decl_version text;
BEGIN
  SELECT standard_version INTO decl_version FROM public.eligibility_declarations WHERE id = NEW.declaration_id;
  IF decl_version IS NULL OR NEW.standard_version <> decl_version THEN
    RAISE EXCEPTION 'A result carries the Standard version of the declaration it was determined on (%).', coalesce(decl_version, 'unknown') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS result_matches_declaration_standard ON public.eligibility_results;
CREATE TRIGGER result_matches_declaration_standard BEFORE INSERT ON public.eligibility_results
  FOR EACH ROW EXECUTE FUNCTION public.result_matches_declaration_standard();

-- The first version: 1.1, live. (Run once; re-running changes nothing.) It goes last on purpose: the "exactly one
-- live" check is deferred to the end of the transaction, and a table with a pending check can't be altered.
INSERT INTO public.standard_versions (version, effective_from, is_live, file_url)
SELECT '1.1', '2026-11-04T00:00:00Z', true, 'standards/Participant_Eligibility_Standard_v1.1.pdf'
WHERE NOT EXISTS (SELECT 1 FROM public.standard_versions);
