-- divieight — Commission Settlement: Source of Truth + CDA (Prompt 11).
--
-- Each generation is a new version; the latest transmitted version is the
-- instruction title/escrow pays from, and the reference the Disbursement
-- Check (Prompt 16) compares against. The platform never holds or disburses
-- commission funds — these rows are instructions only.
--
-- Run this in the external Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.settlement_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated','transmitted','superseded')),
  structured jsonb NOT NULL,
  content_hash text NOT NULL,
  total_commission_cents bigint NOT NULL,
  pdf_url text,
  provider text,
  external_reference text,
  simulated boolean,
  transmitted_at timestamptz,
  generated_by uuid,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, version)
);
CREATE INDEX IF NOT EXISTS settlement_documents_property_idx
  ON public.settlement_documents (property_id, version DESC);

GRANT SELECT ON public.settlement_documents TO authenticated;
GRANT ALL ON public.settlement_documents TO service_role;
ALTER TABLE public.settlement_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins read settlement documents" ON public.settlement_documents;
CREATE POLICY "admins read settlement documents"
  ON public.settlement_documents FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
