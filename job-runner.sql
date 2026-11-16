-- Dead-letter queue for scheduled jobs. Run once in the Supabase SQL editor. Safe to run again.
--
-- A scheduled job (src/lib/job-runner.server.ts) runs with a time limit and one retry. A job that still fails is written here, with a short error that has no personal
-- data, and the Managers are notified. Only the server (service role) reads or writes this table: no signed-in user can, through the API.

CREATE TABLE IF NOT EXISTS public.job_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  error text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  -- Set when someone has looked at it. The row itself is never edited or removed.
  resolved_at timestamptz,
  resolved_by uuid
);
CREATE INDEX IF NOT EXISTS job_failures_name_time_idx ON public.job_failures (job_name, failed_at DESC);

ALTER TABLE public.job_failures ENABLE ROW LEVEL SECURITY;
-- No policy for anon or authenticated: the table is invisible to them. The service role bypasses RLS.
REVOKE ALL ON public.job_failures FROM anon, authenticated;

-- Append-only for every role except the single "resolved" mark: no DELETE, no TRUNCATE, and an UPDATE may change only resolved_at and resolved_by.
CREATE OR REPLACE FUNCTION public.job_failures_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'job_failures is append-only';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.job_name IS DISTINCT FROM OLD.job_name OR NEW.attempts IS DISTINCT FROM OLD.attempts
     OR NEW.error IS DISTINCT FROM OLD.error OR NEW.failed_at IS DISTINCT FROM OLD.failed_at THEN
    RAISE EXCEPTION 'job_failures is append-only: only resolved_at and resolved_by may be set';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS job_failures_guard_row ON public.job_failures;
CREATE TRIGGER job_failures_guard_row BEFORE UPDATE OR DELETE ON public.job_failures FOR EACH ROW EXECUTE FUNCTION public.job_failures_guard();
DROP TRIGGER IF EXISTS job_failures_guard_truncate ON public.job_failures;
CREATE TRIGGER job_failures_guard_truncate BEFORE TRUNCATE ON public.job_failures FOR EACH STATEMENT EXECUTE FUNCTION public.job_failures_guard();
