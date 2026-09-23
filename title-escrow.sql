-- divieight — Title/Escrow Real-Time Handshake + Title Certainty Monitor
-- (Prompt 10). SIMULATED Qualia integration until a partnership agreement and
-- GraphQL credentials exist; the provider column lets SoftPro slot in later.
--
-- Run this in the external Supabase SQL editor.

-- One order per property with the title/escrow company (the Closing Bundle).
CREATE TABLE IF NOT EXISTS public.title_escrow_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL UNIQUE REFERENCES public.properties(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'qualia' CHECK (provider IN ('qualia','softpro')),
  external_order_id text NOT NULL UNIQUE,
  simulated boolean NOT NULL DEFAULT true,
  bundle_payload jsonb NOT NULL,
  bundle_sent_at timestamptz NOT NULL DEFAULT now(),
  source_request_id uuid,
  current_milestone text,
  status text NOT NULL DEFAULT 'bundle_sent'
    CHECK (status IN ('bundle_sent','in_progress','completed')),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.title_escrow_orders TO authenticated;
GRANT ALL ON public.title_escrow_orders TO service_role;
ALTER TABLE public.title_escrow_orders ENABLE ROW LEVEL SECURITY;

-- Every milestone webhook received (real or simulated).
CREATE TABLE IF NOT EXISTS public.title_escrow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  milestone text NOT NULL CHECK (milestone IN (
    'order_opened','title_report_ready','earnest_money_deposited',
    'closing_scheduled','funded_and_recorded'
  )),
  received_at timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb NOT NULL,
  provider text NOT NULL DEFAULT 'qualia',
  -- Provider's event id: redelivered webhooks are ignored.
  external_event_id text UNIQUE,
  simulated boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS title_escrow_events_property_idx
  ON public.title_escrow_events (property_id, received_at);

GRANT SELECT ON public.title_escrow_events TO authenticated;
GRANT ALL ON public.title_escrow_events TO service_role;
ALTER TABLE public.title_escrow_events ENABLE ROW LEVEL SECURITY;

-- "Zero-Error" early checks: platform tracking vs. what the title company says.
CREATE TABLE IF NOT EXISTS public.title_escrow_discrepancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  event_id uuid REFERENCES public.title_escrow_events(id) ON DELETE SET NULL,
  kind text NOT NULL,
  buyer_account_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS title_escrow_discrepancies_open_idx
  ON public.title_escrow_discrepancies (status, created_at DESC);

GRANT SELECT ON public.title_escrow_discrepancies TO authenticated;
GRANT ALL ON public.title_escrow_discrepancies TO service_role;
ALTER TABLE public.title_escrow_discrepancies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins read title discrepancies" ON public.title_escrow_discrepancies;
CREATE POLICY "admins read title discrepancies"
  ON public.title_escrow_discrepancies FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
