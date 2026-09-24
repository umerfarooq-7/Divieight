-- divieight — Closing Ping Saga (Prompt 13).
--
-- Runs on the orchestrator from Prompt 12 (saga.sql must already be applied).
-- Everything here records INSTRUCTION/STATUS only — title/escrow pays from
-- sale proceeds per the Source of Truth; the platform never moves funds.
--
-- Run this in the external Supabase SQL editor.

-- Recordation + governance ----------------------------------------------------
ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS deed_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS deed_recording_reference text;

ALTER TABLE public.pods
  ADD COLUMN IF NOT EXISTS governance_status text NOT NULL DEFAULT 'inactive'
    CHECK (governance_status IN ('inactive','active')),
  ADD COLUMN IF NOT EXISTS governance_activated_at timestamptz;

ALTER TABLE public.cap_table_entries
  ADD COLUMN IF NOT EXISTS retention_lock_started_at timestamptz;

-- Digital Keys: co-owner access to management/governance tools.
CREATE TABLE IF NOT EXISTS public.co_owner_digital_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  holder_type text NOT NULL CHECK (holder_type IN ('buyer_account','retained_seller')),
  buyer_account_id uuid REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  seller_id uuid,
  shares integer NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  issued_at timestamptz NOT NULL DEFAULT now()
);
-- One key per holder (partial indexes: a plain UNIQUE ignores the NULL column).
CREATE UNIQUE INDEX IF NOT EXISTS co_owner_keys_buyer_unique
  ON public.co_owner_digital_keys (property_id, buyer_account_id) WHERE holder_type = 'buyer_account';
CREATE UNIQUE INDEX IF NOT EXISTS co_owner_keys_seller_unique
  ON public.co_owner_digital_keys (property_id, seller_id) WHERE holder_type = 'retained_seller';
GRANT SELECT ON public.co_owner_digital_keys TO authenticated;
GRANT ALL ON public.co_owner_digital_keys TO service_role;
ALTER TABLE public.co_owner_digital_keys ENABLE ROW LEVEL SECURITY;

-- Commission Dashboard ledger (instruction status only) -----------------------
CREATE TABLE IF NOT EXISTS public.commission_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  settlement_document_id uuid NOT NULL REFERENCES public.settlement_documents(id) ON DELETE CASCADE,
  share_number integer NOT NULL,
  buyer_account_id uuid,
  agent_id uuid NOT NULL,
  broker_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('resident_agent','referring_agent','heavy_lifting_agent')),
  gross_cents bigint NOT NULL,
  premium_to_hla_cents bigint NOT NULL DEFAULT 0,
  premium_received_cents bigint NOT NULL DEFAULT 0,
  net_cents bigint NOT NULL,
  status text NOT NULL DEFAULT 'closed_payable_by_title'
    CHECK (status IN ('closed_payable_by_title')),
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (settlement_document_id, share_number, agent_id, role)
);
CREATE INDEX IF NOT EXISTS commission_ledger_agent_idx ON public.commission_ledger (agent_id, unlocked_at DESC);
GRANT SELECT ON public.commission_ledger TO authenticated;
GRANT ALL ON public.commission_ledger TO service_role;
ALTER TABLE public.commission_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agents read own commission ledger" ON public.commission_ledger;
CREATE POLICY "agents read own commission ledger"
  ON public.commission_ledger FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.agents a WHERE a.id = commission_ledger.agent_id AND a.auth_user_id = auth.uid()));

-- Disbursement Check results (Prompt 16 reuses this) --------------------------
CREATE TABLE IF NOT EXISTS public.disbursement_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  settlement_document_id uuid REFERENCES public.settlement_documents(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('pass','fail')),
  platform_total_cents bigint NOT NULL,
  title_total_cents bigint,
  differences jsonb NOT NULL DEFAULT '[]'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS disbursement_checks_property_idx ON public.disbursement_checks (property_id, checked_at DESC);
GRANT SELECT ON public.disbursement_checks TO authenticated;
GRANT ALL ON public.disbursement_checks TO service_role;
ALTER TABLE public.disbursement_checks ENABLE ROW LEVEL SECURITY;

-- Per-recipient idempotency for saga notifications (no duplicate "Deal Closed").
CREATE TABLE IF NOT EXISTS public.saga_notifications_sent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  recipient text NOT NULL,
  -- 'pending' = claimed but not confirmed delivered; a retry re-sends only these.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent')),
  sent_at timestamptz
);
GRANT ALL ON public.saga_notifications_sent TO service_role;
ALTER TABLE public.saga_notifications_sent ENABLE ROW LEVEL SECURITY;
