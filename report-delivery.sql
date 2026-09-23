-- divieight — Appraisal & Inspection Report Delivery (Prompt 6).
--
-- A delivered report lives in the existing Virtual Data Room
-- (property_documents) AND the Due Diligence Inventory as a Required
-- document. This table only records the delivery itself — no third storage
-- location — plus any Material-Adverse-Finding flags and Resident Agent notes.
--
-- Run this in the external Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.property_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  report_type text NOT NULL CHECK (report_type IN ('appraisal', 'inspection')),
  title text NOT NULL,
  vendor_name text,
  report_date date,
  file_url text NOT NULL,
  content_hash text NOT NULL,
  data_room_document_id uuid REFERENCES public.property_documents(id) ON DELETE SET NULL,
  diligence_document_id uuid REFERENCES public.due_diligence_inventory(id) ON DELETE SET NULL,
  -- Appraisal inputs for the below-contract-price flag (null for inspections).
  contract_price numeric,
  appraised_value numeric,
  -- Extracted/pasted report text, scanned for flag phrases only.
  report_text text,
  -- [{ code, message }] — non-substantive: surfaces a finding's existence only.
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  supersedes_report_id uuid REFERENCES public.property_reports(id) ON DELETE SET NULL,
  received_by uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS property_reports_property_idx
  ON public.property_reports (property_id, received_at DESC);

GRANT SELECT ON public.property_reports TO authenticated;
GRANT ALL ON public.property_reports TO service_role;
ALTER TABLE public.property_reports ENABLE ROW LEVEL SECURITY;

-- Reads go through server functions (service role) that check the caller is
-- an admin, a reserved Buyer Account, or that account's tethered agent.
DROP POLICY IF EXISTS "admins read property reports" ON public.property_reports;
CREATE POLICY "admins read property reports"
  ON public.property_reports FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Resident Agent annotations: the ONLY interpretation layer. Each note is
-- written by the buyer's tethered agent and visible to that buyer only.
CREATE TABLE IF NOT EXISTS public.report_annotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES public.property_reports(id) ON DELETE CASCADE,
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_annotations_report_idx
  ON public.report_annotations (report_id, buyer_account_id);

GRANT SELECT ON public.report_annotations TO authenticated;
GRANT ALL ON public.report_annotations TO service_role;
ALTER TABLE public.report_annotations ENABLE ROW LEVEL SECURITY;

-- Flag thresholds are adjustable without a deploy.
INSERT INTO public.platform_settings (key, value)
VALUES ('report_flags', '{"appraisal_shortfall_percent": 2}'::jsonb)
ON CONFLICT (key) DO NOTHING;
