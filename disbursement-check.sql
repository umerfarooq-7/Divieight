-- divieight — Disbursement Check, standalone (Prompt 16).
--
-- Extends Prompt 13's disbursement_checks with the full line-item result, the
-- source of the title figures and the human-readable discrepancy report, and
-- adds manual entry of the title company's numbers for testing (no real title
-- company feed yet).
--
-- Run this in the external Supabase SQL editor (after closing-saga.sql).

ALTER TABLE public.disbursement_checks
  ADD COLUMN IF NOT EXISTS lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS title_source text,
  ADD COLUMN IF NOT EXISTS report text,
  ADD COLUMN IF NOT EXISTS source_of_truth_hash text,
  ADD COLUMN IF NOT EXISTS triggered_by text;

-- Title company's final numbers, entered by hand (e.g. from its settlement
-- statement) until a live title feed exists.
CREATE TABLE IF NOT EXISTS public.title_reported_figures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  -- [{ payeeReference (broker id), amount (USD) }]
  figures jsonb NOT NULL,
  note text,
  entered_by uuid,
  entered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS title_reported_figures_property_idx
  ON public.title_reported_figures (property_id, entered_at DESC);

GRANT SELECT ON public.title_reported_figures TO authenticated;
GRANT ALL ON public.title_reported_figures TO service_role;
ALTER TABLE public.title_reported_figures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins read title figures" ON public.title_reported_figures;
CREATE POLICY "admins read title figures"
  ON public.title_reported_figures FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
