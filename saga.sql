-- divieight — Saga orchestration proof of concept (Prompt 12).
--
-- Generic tables for the orchestrator (reused by the real Closing Ping Saga
-- in Prompt 13) plus `saga_test_log`, the PoC's only side-effect target.
-- Nothing here touches property, commission or closing data.
--
-- Run this in the external Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.saga_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  saga_type text NOT NULL,
  saga_key text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Lease so a crashed runner doesn't hold the saga forever.
  lease_expires_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The idempotency guarantee: one run per (type, key), ever.
  UNIQUE (saga_type, saga_key)
);

CREATE TABLE IF NOT EXISTS public.saga_step_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.saga_runs(id) ON DELETE CASCADE,
  step_name text NOT NULL,
  -- `<type>:<key>:<step>` — handed to the step so external effects can dedupe.
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  result jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS saga_step_executions_run_idx ON public.saga_step_executions (run_id);

-- Dead letter: sagas whose retries are exhausted, for manual review.
CREATE TABLE IF NOT EXISTS public.saga_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  saga_type text NOT NULL,
  saga_key text NOT NULL,
  failed_step text NOT NULL,
  error_detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text
);
CREATE INDEX IF NOT EXISTS saga_failures_open_idx ON public.saga_failures (created_at DESC) WHERE resolved_at IS NULL;

-- PoC side-effect target. The unique key makes a step's effect idempotent
-- even if the step crashes after writing and is retried.
CREATE TABLE IF NOT EXISTS public.saga_test_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  saga_key text NOT NULL,
  step_name text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['saga_runs','saga_step_executions','saga_failures','saga_test_log'] LOOP
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
