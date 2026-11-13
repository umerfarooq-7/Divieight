-- Versioned Terms and Conditions, with change notices.
-- Run in the Supabase SQL editor. Safe to run again. Only adds three tables: nothing existing is changed.
--
--   * tc_versions: every published version of the Terms and Conditions, with exactly ONE current. A version is never edited or deleted (only its "current"
--     flag is cleared when a later one is published), so every previous version stays readable. A MATERIAL version carries a summary of changes.
--   * tc_notice_deliveries: who was told about a material version, when, and on which channel (portal or email). One row per person per channel per version.
--   * tc_acceptances: acceptance by continued use after a version's effective date, with the version. An implicit acceptance: nobody is made to re-sign.
--
-- The Priority Reservation Agreement and the Operating Agreement have their own versions. A revision of either is not a change to these Terms, never
-- creates a row here, never notifies existing signers as a Terms change, and applies only to documents made after it.

CREATE TABLE IF NOT EXISTS public.tc_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE,
  effective_date date NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  is_material boolean NOT NULL DEFAULT false,
  summary_of_changes text,
  published_by uuid,
  published_at timestamptz NOT NULL DEFAULT now(),
  previous_version_id uuid REFERENCES public.tc_versions(id),
  -- Exactly one version is current: the latest published.
  is_current boolean NOT NULL DEFAULT false,
  -- A material revision cannot be published without saying what changed.
  CONSTRAINT tc_material_has_summary CHECK (NOT is_material OR length(btrim(coalesce(summary_of_changes, ''))) >= 10)
);
CREATE UNIQUE INDEX IF NOT EXISTS tc_versions_one_current ON public.tc_versions ((true)) WHERE is_current;

CREATE OR REPLACE FUNCTION public.tc_versions_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A published Terms version is never deleted.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.version <> OLD.version OR NEW.effective_date <> OLD.effective_date OR NEW.body <> OLD.body OR NEW.is_material <> OLD.is_material
     OR NEW.summary_of_changes IS DISTINCT FROM OLD.summary_of_changes OR NEW.published_by IS DISTINCT FROM OLD.published_by
     OR NEW.published_at <> OLD.published_at OR NEW.previous_version_id IS DISTINCT FROM OLD.previous_version_id THEN
    RAISE EXCEPTION 'A published Terms version is never edited. Publish a new version instead.' USING ERRCODE = 'check_violation';
  END IF;
  -- Only the current flag may change (cleared when a later version is published, or restored if that publication fails). The one-current index keeps it to one.
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tc_versions_history ON public.tc_versions;
CREATE TRIGGER tc_versions_history BEFORE UPDATE OR DELETE ON public.tc_versions FOR EACH ROW EXECUTE FUNCTION public.tc_versions_guard();

CREATE OR REPLACE FUNCTION public.tc_record_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is a record: it is never edited or deleted.', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;

CREATE TABLE IF NOT EXISTS public.tc_notice_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tc_version_id uuid NOT NULL REFERENCES public.tc_versions(id),
  auth_user_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('portal', 'email')),
  -- False when the channel could not be used (no address on file, or the email provider refused it).
  delivered boolean NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tc_version_id, auth_user_id, channel)
);
CREATE INDEX IF NOT EXISTS tc_notice_deliveries_version_idx ON public.tc_notice_deliveries (tc_version_id);
DROP TRIGGER IF EXISTS tc_notice_deliveries_history ON public.tc_notice_deliveries;
CREATE TRIGGER tc_notice_deliveries_history BEFORE UPDATE OR DELETE ON public.tc_notice_deliveries FOR EACH ROW EXECUTE FUNCTION public.tc_record_immutable();

CREATE TABLE IF NOT EXISTS public.tc_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL,
  tc_version_id uuid NOT NULL REFERENCES public.tc_versions(id),
  version text NOT NULL,
  kind text NOT NULL DEFAULT 'implicit_continued_use' CHECK (kind = 'implicit_continued_use'),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  UNIQUE (auth_user_id, tc_version_id)
);
CREATE INDEX IF NOT EXISTS tc_acceptances_user_idx ON public.tc_acceptances (auth_user_id, accepted_at);
DROP TRIGGER IF EXISTS tc_acceptances_history ON public.tc_acceptances;
CREATE TRIGGER tc_acceptances_history BEFORE UPDATE OR DELETE ON public.tc_acceptances FOR EACH ROW EXECUTE FUNCTION public.tc_record_immutable();

ALTER TABLE public.tc_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tc_notice_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tc_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tc_versions, public.tc_notice_deliveries, public.tc_acceptances FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.tc_versions TO service_role;
GRANT SELECT, INSERT ON public.tc_notice_deliveries, public.tc_acceptances TO service_role;
REVOKE ALL ON FUNCTION public.tc_versions_guard(), public.tc_record_immutable() FROM PUBLIC, anon, authenticated;
-- The Terms are public: the website reads them through the server (the public /terms page), so there is no direct policy for anon or members. Everyone
-- reads and writes through the server, which checks who is asking.
