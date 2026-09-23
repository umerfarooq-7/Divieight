-- divieight — Closing-Cost Funding Coordination (Prompt 7).
--
-- Same shape as earnest money: a per-property notice (terms) and one
-- obligation per Buyer Account. Funds go directly to escrow; these tables
-- only record the instruction and its status.
--
-- Run this in the external Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.closing_funds_terms (
  property_id uuid PRIMARY KEY REFERENCES public.properties(id) ON DELETE CASCADE,
  total_amount numeric NOT NULL,
  shares_basis integer NOT NULL,
  per_share_amount numeric NOT NULL,
  funding_deadline timestamptz NOT NULL,
  escrow_company text NOT NULL,
  escrow_account_details text NOT NULL,
  escrow_reference text,
  escrow_contact_email text,
  funding_methods text[] NOT NULL DEFAULT ARRAY['Wire transfer'],
  source_request_id uuid,
  issued_by uuid,
  issued_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.closing_funds_terms TO authenticated;
GRANT ALL ON public.closing_funds_terms TO service_role;
ALTER TABLE public.closing_funds_terms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "buyers read closing terms for their pods" ON public.closing_funds_terms;
CREATE POLICY "buyers read closing terms for their pods"
  ON public.closing_funds_terms FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.pod_reservations r
      JOIN public.buyer_accounts b ON b.id = r.buyer_account_id
      WHERE r.property_id = closing_funds_terms.property_id
        AND b.auth_user_id = auth.uid()
    )
  );

CREATE TABLE IF NOT EXISTS public.closing_funds_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  amount numeric NOT NULL,
  shares integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','funded','late','missed')),
  funding_deadline timestamptz NOT NULL,
  funded_at timestamptz,
  funded_reference text,
  marked_by uuid,
  late_at timestamptz,
  missed_at timestamptz,
  is_substitute boolean NOT NULL DEFAULT false,
  replaces_obligation_id uuid REFERENCES public.closing_funds_obligations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS closing_obligation_unique
  ON public.closing_funds_obligations (property_id, buyer_account_id);
CREATE INDEX IF NOT EXISTS closing_obligation_status_idx
  ON public.closing_funds_obligations (status, funding_deadline);

GRANT SELECT ON public.closing_funds_obligations TO authenticated;
GRANT ALL ON public.closing_funds_obligations TO service_role;
ALTER TABLE public.closing_funds_obligations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "buyer reads own closing obligations" ON public.closing_funds_obligations;
CREATE POLICY "buyer reads own closing obligations"
  ON public.closing_funds_obligations FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.buyer_accounts b
      WHERE b.id = closing_funds_obligations.buyer_account_id
        AND b.auth_user_id = auth.uid()
    )
  );

INSERT INTO public.platform_settings (key, value)
VALUES ('closing_funds', '{"grace_hours":24,"substitute_minimum_hours":24}'::jsonb)
ON CONFLICT (key) DO NOTHING;
