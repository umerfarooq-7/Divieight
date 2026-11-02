-- Owner area: LLC tabs (governance rules and notices).
-- Run once in the Supabase SQL editor, AFTER owner-dashboard.sql. Safe to re-run.
-- Only adds two tables and seeds default rules; existing tables are untouched.

-- property_id NULL = the default for every property. A property's own row with
-- the same section_key replaces that default on that property.
CREATE TABLE IF NOT EXISTS public.governance_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid REFERENCES public.properties(id) ON DELETE CASCADE,
  section_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS governance_rules_default_key
  ON public.governance_rules (section_key) WHERE property_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS governance_rules_property_key
  ON public.governance_rules (property_id, section_key) WHERE property_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.owner_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX IF NOT EXISTS owner_notices_property_idx ON public.owner_notices (property_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.governance_rules, public.owner_notices TO authenticated;
GRANT ALL ON public.governance_rules, public.owner_notices TO service_role;
ALTER TABLE public.governance_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owners read governance rules" ON public.governance_rules;
CREATE POLICY "owners read governance rules" ON public.governance_rules
  FOR SELECT TO authenticated
  USING (property_id IS NULL OR public.is_property_owner(auth.uid(), property_id));
DROP POLICY IF EXISTS "admins manage governance rules" ON public.governance_rules;
CREATE POLICY "admins manage governance rules" ON public.governance_rules
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "owners read notices" ON public.owner_notices;
CREATE POLICY "owners read notices" ON public.owner_notices
  FOR SELECT TO authenticated
  USING (public.is_property_owner(auth.uid(), property_id));
DROP POLICY IF EXISTS "admins manage notices" ON public.owner_notices;
CREATE POLICY "admins manage notices" ON public.owner_notices
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Default rules. Existing rows are never overwritten, so admin edits survive a re-run.
INSERT INTO public.governance_rules (property_id, section_key, title, body, sort_order) VALUES
  (NULL, 'one_vote_per_share', 'One vote per 1/8th share',
   'Each 1/8th share carries one vote on matters that go to the members.', 10),
  (NULL, 'multi_member_consensus', 'Multi-member accounts decide internally',
   'A Buyer Account with more than one member reaches consensus internally and votes its share as one.', 20),
  (NULL, 'use_calendar_rotation', 'Use Calendar rotation',
   'Occupancy is allocated through the Use Calendar on an equal-entitlement basis. Peak, holiday and high-demand periods rotate so that no share obtains a persistent advantage across successive years.', 30),
  (NULL, 'retention_lock', 'Retention Lock: 12 months',
   'Each share is subject to a 12-month Retention Lock. A hardship exception is available under Operating Agreement §6.e.', 40),
  (NULL, 'resale_rofr', 'Resale Shop right of first refusal: 10 days',
   'A share offered through the Resale Shop is subject to a 10-day right of first refusal.', 50),
  (NULL, 'capital_calls', 'Capital calls',
   'Capital calls beyond the reserve schedule require member approval as provided in the Operating Agreement.', 60)
ON CONFLICT (section_key) WHERE property_id IS NULL DO NOTHING;
