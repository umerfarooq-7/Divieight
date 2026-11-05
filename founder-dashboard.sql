-- Founder Dashboard: read-only materialized views. Run once in the Supabase SQL editor,
-- AFTER every earlier file, conversion-events.sql and resale-shop.sql included. Safe to
-- re-run. Only adds views, one small table and one function; nothing existing changes.
--
-- A materialized view can't have row-level security, so these are closed to everyone
-- except the server (service role), which checks for an admin before reading them.
-- They hold no names of buyers, no emails, no phones and no exact budgets.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.founder_mv_properties AS
SELECT
  p.id,
  p.city,
  p.state,
  p.listing_price,
  p.status,
  p.listing_status::text AS listing_status,
  p.hard_locked,
  p.published_at,
  p.deed_recorded_at,
  -- No column records the moment a pod fills, so it comes from the data: the last
  -- reservation that took retained + reserved to 8, else the Closing-Ready stamp.
  COALESCE(
    CASE WHEN COALESCE(CASE WHEN p.exit_type = 'hybrid_exit' THEN p.retained_shares END, 0) + COALESCE(r.reserved, 0) >= 8 THEN r.last_reserved_at END,
    g.closing_ready_at
  ) AS eight_of_eight_at,
  COALESCE(t.simulated, false) AS closing_simulated
FROM public.properties p
LEFT JOIN LATERAL (
  SELECT SUM(x.shares_reserved) AS reserved, MAX(x.reserved_at) AS last_reserved_at
  FROM public.pod_reservations x WHERE x.property_id = p.id AND x.status = 'reserved'
) r ON true
LEFT JOIN public.entity_genesis g ON g.property_id = p.id
LEFT JOIN public.title_escrow_orders t ON t.property_id = p.id;
CREATE UNIQUE INDEX IF NOT EXISTS founder_mv_properties_key ON public.founder_mv_properties (id);

-- Cleared Platform Enrollment Fees, at the amount actually recorded.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.founder_mv_pef AS
SELECT
  'buyer:' || pay.id::text AS key,
  'buyer' AS source,
  pay.environment,
  pay.amount_cents,
  COALESCE(c.pef_cleared_at, pay.updated_at) AS cleared_at,
  b.primary_target_market AS market
FROM public.buyer_enrollment_payments pay
LEFT JOIN public.buyer_accounts b ON b.id = pay.buyer_account_id
LEFT JOIN LATERAL (
  SELECT e.pef_cleared_at FROM public.conversion_events e WHERE e.buyer_account_id = pay.buyer_account_id ORDER BY e.created_at LIMIT 1
) c ON true
WHERE pay.status = 'paid'
UNION ALL
SELECT
  'seller:' || pay.id::text,
  'seller',
  pay.environment,
  pay.amount_cents,
  pay.updated_at,
  p.state
FROM public.enrollment_payments pay
LEFT JOIN public.properties p ON p.id = pay.property_id
WHERE pay.status = 'paid';
CREATE UNIQUE INDEX IF NOT EXISTS founder_mv_pef_key ON public.founder_mv_pef (key);

-- The commission cascade as recorded at closing, latest settlement version only.
-- Instruction status only: title/escrow pays broker to broker, never the platform.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.founder_mv_commissions AS
SELECT
  l.id,
  p.state,
  l.role,
  l.premium_received_cents,
  l.gross_cents - l.premium_to_hla_cents AS agent_yield_cents,
  l.unlocked_at,
  COALESCE(t.simulated, false) AS closing_simulated
FROM public.commission_ledger l
JOIN public.settlement_documents d ON d.id = l.settlement_document_id
JOIN public.properties p ON p.id = l.property_id
LEFT JOIN public.title_escrow_orders t ON t.property_id = l.property_id
WHERE d.version = (
  SELECT MAX(d2.version) FROM public.settlement_documents d2
  WHERE d2.id IN (SELECT l2.settlement_document_id FROM public.commission_ledger l2 WHERE l2.property_id = l.property_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS founder_mv_commissions_key ON public.founder_mv_commissions (id);

-- Buyers for counting only: a bucket, never a budget; an id, never a name or email.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.founder_mv_buyers AS
SELECT
  b.id,
  b.primary_target_market AS market,
  b.target_budget_bucket AS budget_bucket,
  b.onboarding_status,
  b.created_at,
  b.referring_agent_id,
  ref_agent.full_name AS referring_agent_name,
  b.referral_token,
  ref_token.campaign_label AS referral_label,
  s.agent_id AS stamp_agent_id,
  stamp_agent.full_name AS stamp_agent_name,
  stamp_token.token AS stamp_token,
  stamp_token.label AS stamp_label
FROM public.buyer_accounts b
LEFT JOIN public.agents ref_agent ON ref_agent.id = b.referring_agent_id
LEFT JOIN public.attribution_tokens ref_token ON ref_token.token = b.referral_token
LEFT JOIN public.buyer_attribution s ON s.buyer_user_id = b.auth_user_id
LEFT JOIN public.agents stamp_agent ON stamp_agent.id = s.agent_id
LEFT JOIN public.agent_attribution_tokens stamp_token ON stamp_token.id = s.token_id;
CREATE UNIQUE INDEX IF NOT EXISTS founder_mv_buyers_key ON public.founder_mv_buyers (id);

-- Each issued share's lock, with the same exception rule as is_share_locked().
CREATE MATERIALIZED VIEW IF NOT EXISTS public.founder_mv_shares AS
SELECT
  c.property_id::text || ':' || c.share_number::text AS key,
  p.state,
  c.retention_lock_expires_at,
  EXISTS (
    SELECT 1 FROM public.retention_exceptions e
    WHERE e.property_id = c.property_id AND e.share_number = c.share_number AND e.status = 'approved'
      AND e.requested_by_user_id = CASE
        WHEN c.holder_type = 'retained_seller' THEN c.seller_id
        ELSE (SELECT b.auth_user_id FROM public.buyer_accounts b WHERE b.id = c.buyer_account_id)
      END
  ) AS exception_approved
FROM public.cap_table_entries c
JOIN public.properties p ON p.id = c.property_id;
CREATE UNIQUE INDEX IF NOT EXISTS founder_mv_shares_key ON public.founder_mv_shares (key);

CREATE MATERIALIZED VIEW IF NOT EXISTS public.founder_mv_exceptions AS
SELECT e.id, p.state, e.status, e.created_at
FROM public.retention_exceptions e JOIN public.properties p ON p.id = e.property_id;
CREATE UNIQUE INDEX IF NOT EXISTS founder_mv_exceptions_key ON public.founder_mv_exceptions (id);

CREATE MATERIALIZED VIEW IF NOT EXISTS public.founder_mv_resale AS
SELECT l.id, p.state, l.status, l.created_at
FROM public.resale_listings l JOIN public.properties p ON p.id = l.property_id;
CREATE UNIQUE INDEX IF NOT EXISTS founder_mv_resale_key ON public.founder_mv_resale (id);

CREATE TABLE IF NOT EXISTS public.founder_dashboard_refreshes (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.founder_dashboard_refreshes (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Nightly and on demand. CONCURRENTLY: the dashboard keeps working during a refresh.
CREATE OR REPLACE FUNCTION public.refresh_founder_dashboard()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  stamp timestamptz := now();
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.founder_mv_properties;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.founder_mv_pef;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.founder_mv_commissions;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.founder_mv_buyers;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.founder_mv_shares;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.founder_mv_exceptions;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.founder_mv_resale;
  UPDATE public.founder_dashboard_refreshes SET refreshed_at = stamp WHERE id = 1;
  RETURN stamp;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_founder_dashboard() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_founder_dashboard() TO service_role;

-- Supabase's default grants would otherwise expose these through the public API.
REVOKE ALL ON public.founder_mv_properties, public.founder_mv_pef, public.founder_mv_commissions, public.founder_mv_buyers,
  public.founder_mv_shares, public.founder_mv_exceptions, public.founder_mv_resale, public.founder_dashboard_refreshes
  FROM public, anon, authenticated;
GRANT SELECT ON public.founder_mv_properties, public.founder_mv_pef, public.founder_mv_commissions, public.founder_mv_buyers,
  public.founder_mv_shares, public.founder_mv_exceptions, public.founder_mv_resale, public.founder_dashboard_refreshes
  TO service_role;
ALTER TABLE public.founder_dashboard_refreshes ENABLE ROW LEVEL SECURITY;

SELECT public.refresh_founder_dashboard();
