-- Owner notifications, on the EXISTING notifications table. Run once in the Supabase SQL editor,
-- AFTER owner-dashboard.sql. Safe to re-run.
-- Adds two nullable columns to notifications; existing rows and existing senders are unaffected.

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.properties(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dedupe_key text;

-- One notification per person per event, however many sweeps or retries run.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_per_event
  ON public.notifications (seller_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_property_idx ON public.notifications (property_id) WHERE property_id IS NOT NULL;

-- Email on or off, per type. In-app is always on, so it isn't stored.
CREATE TABLE IF NOT EXISTS public.owner_notification_preferences (
  user_id uuid NOT NULL,
  type text NOT NULL,
  email_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type),
  -- Rev 48 floor: these three can never be switched off, whoever writes the row.
  CHECK (email_enabled OR type NOT IN ('governance_vote_window', 'capital_call_alert', 'notice_posted'))
);

-- Display only: this records the announcement. No money moves and no balance changes.
CREATE TABLE IF NOT EXISTS public.distribution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  total_amount numeric(12, 2) NOT NULL CHECK (total_amount > 0),
  record_date date NOT NULL,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS distribution_events_property_idx ON public.distribution_events (property_id, created_at DESC);

GRANT SELECT ON public.owner_notification_preferences, public.distribution_events TO authenticated;
GRANT ALL ON public.owner_notification_preferences, public.distribution_events TO service_role;
ALTER TABLE public.owner_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distribution_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "people read their own notification preferences" ON public.owner_notification_preferences;
CREATE POLICY "people read their own notification preferences" ON public.owner_notification_preferences
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "owners read their property's distributions" ON public.distribution_events;
CREATE POLICY "owners read their property's distributions" ON public.distribution_events
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.is_property_owner(auth.uid(), property_id));
