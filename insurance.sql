-- divieight — Insurance Procurement by the Manager (Prompt 8, Rev 48).
--
-- divieight, LLC as Manager selects and procures homeowners/hazard coverage
-- for every property under the Block 2 authority already granted. No
-- Strategic Insurance Partner logic exists — only the Manager-procures path,
-- plus the Buyer Accounts' Right to Shop for an alternative.
--
-- Run this in the external Supabase SQL editor.

-- 1. Versioned coverage requirements --------------------------------------
-- ⚠️ PLACEHOLDER VALUES — must be replaced with real minimums from platform
-- compliance before the first live closing.
CREATE TABLE IF NOT EXISTS public.coverage_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE,
  -- [{ min_replacement_cost, max_replacement_cost|null, declared_use:
  --    'personal_use'|'short_term_rental', min_dwelling_coverage,
  --    min_liability_coverage }]
  rules jsonb NOT NULL,
  is_placeholder boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT false,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS coverage_requirements_one_active
  ON public.coverage_requirements (is_active) WHERE is_active;

GRANT SELECT ON public.coverage_requirements TO authenticated;
GRANT ALL ON public.coverage_requirements TO service_role;
ALTER TABLE public.coverage_requirements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated read coverage requirements" ON public.coverage_requirements;
CREATE POLICY "authenticated read coverage requirements"
  ON public.coverage_requirements FOR SELECT TO authenticated USING (true);

INSERT INTO public.coverage_requirements (version, rules, is_placeholder, is_active, notes, activated_at)
SELECT 1,
  '[
    {"min_replacement_cost":0,"max_replacement_cost":1000000,"declared_use":"personal_use","min_dwelling_coverage":1000000,"min_liability_coverage":300000},
    {"min_replacement_cost":1000000,"max_replacement_cost":null,"declared_use":"personal_use","min_dwelling_coverage":2500000,"min_liability_coverage":500000},
    {"min_replacement_cost":0,"max_replacement_cost":1000000,"declared_use":"short_term_rental","min_dwelling_coverage":1000000,"min_liability_coverage":1000000},
    {"min_replacement_cost":1000000,"max_replacement_cost":null,"declared_use":"short_term_rental","min_dwelling_coverage":2500000,"min_liability_coverage":2000000}
  ]'::jsonb,
  true, true,
  'PLACEHOLDER VALUES — must be replaced with real minimums from platform compliance before the first live closing.',
  now()
WHERE NOT EXISTS (SELECT 1 FROM public.coverage_requirements);

-- 2. Right to Shop: alternative carriers proposed by Buyer Accounts ---------
CREATE TABLE IF NOT EXISTS public.insurance_alternative_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  carrier_name text NOT NULL,
  policy_summary text,
  coverage_amount numeric NOT NULL,
  liability_coverage numeric NOT NULL,
  premium numeric NOT NULL,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','approved','rejected','selected','not_selected')),
  meets_requirements boolean,
  review_notes text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS insurance_proposals_property_idx
  ON public.insurance_alternative_proposals (property_id, created_at);

GRANT SELECT ON public.insurance_alternative_proposals TO authenticated;
GRANT ALL ON public.insurance_alternative_proposals TO service_role;
ALTER TABLE public.insurance_alternative_proposals ENABLE ROW LEVEL SECURITY;

-- One vote per Buyer Account per property, among approved alternatives.
CREATE TABLE IF NOT EXISTS public.insurance_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL REFERENCES public.insurance_alternative_proposals(id) ON DELETE CASCADE,
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, buyer_account_id)
);

GRANT SELECT ON public.insurance_votes TO authenticated;
GRANT ALL ON public.insurance_votes TO service_role;
ALTER TABLE public.insurance_votes ENABLE ROW LEVEL SECURITY;

-- 3. Policies ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.insurance_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  carrier_name text NOT NULL,
  policy_number text NOT NULL,
  coverage_amount numeric NOT NULL,
  liability_coverage numeric,
  premium numeric NOT NULL,
  effective_date date NOT NULL,
  renews_at date,
  procured_by text NOT NULL DEFAULT 'manager' CHECK (procured_by = 'manager'),
  procurement_method text NOT NULL DEFAULT 'default'
    CHECK (procurement_method IN ('default','buyer_alternative')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','bound','lapsed')),
  declared_use text CHECK (declared_use IN ('personal_use','short_term_rental')),
  replacement_cost numeric,
  requirement_version integer,
  alternative_proposal_id uuid REFERENCES public.insurance_alternative_proposals(id) ON DELETE SET NULL,
  renewed_from_policy_id uuid REFERENCES public.insurance_policies(id) ON DELETE SET NULL,
  -- Premium is an LLC operating expense (Module 22 placeholder); these fields
  -- feed the annual LLC budget view when it exists.
  premium_paid_from text NOT NULL DEFAULT 'llc_operating_account',
  premium_expense_category text NOT NULL DEFAULT 'insurance_premium',
  premium_paid_at timestamptz,
  bound_at timestamptz,
  bound_by uuid,
  lapsed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS insurance_policies_property_idx
  ON public.insurance_policies (property_id, status);
CREATE INDEX IF NOT EXISTS insurance_policies_renewal_idx
  ON public.insurance_policies (renews_at) WHERE status = 'bound';

GRANT SELECT ON public.insurance_policies TO authenticated;
GRANT ALL ON public.insurance_policies TO service_role;
ALTER TABLE public.insurance_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins read insurance policies" ON public.insurance_policies;
CREATE POLICY "admins read insurance policies"
  ON public.insurance_policies FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
