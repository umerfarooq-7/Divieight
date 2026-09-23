-- divieight — Entity Genesis Stage 2: State Filing + EIN (Prompt 9).
--
-- Triggered only at Closing-Ready (retained + reserved = 8/8). MVP filing
-- path is Stripe Atlas ($500/LLC, Delaware filing + EIN) as a manual admin
-- action — no direct Delaware SOS / IRS EIN API integration yet.
--
-- Run this in the external Supabase SQL editor (after entity-genesis.sql).

ALTER TABLE public.entity_genesis
  ADD COLUMN IF NOT EXISTS closing_ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS cap_table_locked_at timestamptz,
  -- Stripe Atlas request (manual/semi-manual)
  ADD COLUMN IF NOT EXISTS atlas_request_status text NOT NULL DEFAULT 'not_requested'
    CHECK (atlas_request_status IN ('not_requested','requested','completed')),
  ADD COLUMN IF NOT EXISTS atlas_reference text,
  ADD COLUMN IF NOT EXISTS atlas_fee numeric NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS atlas_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS atlas_completed_at timestamptz,
  -- Delaware filing
  ADD COLUMN IF NOT EXISTS state_filing_status text NOT NULL DEFAULT 'pending'
    CHECK (state_filing_status IN ('pending','filed','confirmed')),
  ADD COLUMN IF NOT EXISTS filed_at timestamptz,
  ADD COLUMN IF NOT EXISTS state_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS delaware_file_number text,
  -- EIN + IRS TIN Matching
  ADD COLUMN IF NOT EXISTS ein_status text NOT NULL DEFAULT 'pending'
    CHECK (ein_status IN ('pending','issued','verified')),
  ADD COLUMN IF NOT EXISTS ein_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS tin_match_result text
    CHECK (tin_match_result IN ('match','not_found','name_mismatch')),
  ADD COLUMN IF NOT EXISTS tin_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS tin_verified_at timestamptz,
  -- Final Operating Agreement
  ADD COLUMN IF NOT EXISTS final_oa_status text NOT NULL DEFAULT 'not_started'
    CHECK (final_oa_status IN ('not_started','awaiting_signatures','executed')),
  ADD COLUMN IF NOT EXISTS final_oa_text text,
  ADD COLUMN IF NOT EXISTS final_oa_hash text,
  ADD COLUMN IF NOT EXISTS final_oa_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS executed_oa_url text,
  ADD COLUMN IF NOT EXISTS oa_executed_at timestamptz;

-- Property Records Vault: permanent home for formation and closing documents.
CREATE TABLE IF NOT EXISTS public.property_records_vault (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  title text,
  file_url text NOT NULL,
  content_hash text,
  entity_genesis_id uuid REFERENCES public.entity_genesis(id) ON DELETE SET NULL,
  stored_by uuid,
  stored_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS property_records_vault_property_idx
  ON public.property_records_vault (property_id, stored_at DESC);

GRANT SELECT ON public.property_records_vault TO authenticated;
GRANT ALL ON public.property_records_vault TO service_role;
ALTER TABLE public.property_records_vault ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins read records vault" ON public.property_records_vault;
CREATE POLICY "admins read records vault"
  ON public.property_records_vault FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Platform-native signatures on the final Operating Agreement, pinned to the
-- exact document hash. Buyer Accounts sign in parallel, no required order.
CREATE TABLE IF NOT EXISTS public.operating_agreement_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_genesis_id uuid NOT NULL REFERENCES public.entity_genesis(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  account_member_id uuid NOT NULL,
  signed_name text NOT NULL,
  document_hash text NOT NULL,
  secondary_verification_method text NOT NULL,
  ip_address text,
  device_fingerprint text,
  signed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_genesis_id, account_member_id, document_hash)
);

GRANT SELECT ON public.operating_agreement_signatures TO authenticated;
GRANT ALL ON public.operating_agreement_signatures TO service_role;
ALTER TABLE public.operating_agreement_signatures ENABLE ROW LEVEL SECURITY;
