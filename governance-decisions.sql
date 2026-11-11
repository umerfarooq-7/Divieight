-- Governance settings and the resale decisions. Run once in the Supabase SQL editor, AFTER votes.sql,
-- resale-shop.sql and resale-completion.sql. Safe to re-run.
--
--  1. The founder role (the only role that may change a governance setting).
--  2. governance_settings: the admin-editable numbers. The app's constants are the defaults; a row here overrides one.
--  3. votes.thresholds: what each vote started with, so changing a setting never changes a vote that is already open.
--  4. Resale: the right-of-first-refusal window is now a setting (the fixed 240-hour CHECK is replaced), an open-market
--     listing records when it expires, and the next co-owner can be offered a share after a cancelled sale.

-- 1. The founder role. (A new enum value can't be used in the same run that adds it, so giving someone the role is
--    a separate step: see the commented INSERT at the end.)
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'founder';

-- 2. The settings. Only the server (service role) reads and writes them; every change is also in the audit log.
CREATE TABLE IF NOT EXISTS public.governance_settings (
  key text PRIMARY KEY,
  value numeric NOT NULL,
  reason text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.governance_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.governance_settings FROM anon, authenticated;
GRANT ALL ON public.governance_settings TO service_role;

-- 3. The thresholds a vote started with (written when it opens).
ALTER TABLE public.votes ADD COLUMN IF NOT EXISTS thresholds jsonb;
COMMENT ON COLUMN public.votes.thresholds IS
  'The governance thresholds in force when the vote opened (percentages and the capital-call dollar threshold). A vote is tallied against these, never against the live settings.';

-- 4. Resale.
-- 4a. The window is a setting now: drop the fixed 240-hour check, keep "closes after it opens".
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.resale_listings'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%rofr_opens_at +%'
  LOOP
    EXECUTE format('ALTER TABLE public.resale_listings DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.resale_listings DROP CONSTRAINT IF EXISTS resale_listings_window_after_open;
ALTER TABLE public.resale_listings ADD CONSTRAINT resale_listings_window_after_open CHECK (rofr_closes_at > rofr_opens_at);

-- 4b. When an open-market listing expires, and who holds the offer after a cancelled sale.
ALTER TABLE public.resale_listings ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.resale_listings ADD COLUMN IF NOT EXISTS offer_holder_key text;
ALTER TABLE public.resale_listings ADD COLUMN IF NOT EXISTS offer_closes_at timestamptz;

-- 4c. A co-owner's election can now be 'offered' (holding the offer after a cancelled sale) or 'passed' (had it, and
--     the sale was cancelled, they declined, or their time ran out).
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.resale_rofr_elections'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%withdrawn%'
  LOOP
    EXECUTE format('ALTER TABLE public.resale_rofr_elections DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.resale_rofr_elections DROP CONSTRAINT IF EXISTS resale_rofr_elections_status_check;
ALTER TABLE public.resale_rofr_elections ADD CONSTRAINT resale_rofr_elections_status_check
  CHECK (status IN ('active', 'won', 'lost', 'withdrawn', 'offered', 'passed'));

-- 4d. An election is live again only inside a window: the original right-of-first-refusal window, or the offered
--     co-owner's own window after a cancelled sale.
CREATE OR REPLACE FUNCTION public.enforce_rofr_window()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Nested, not AND: member positions have no status column.
  IF TG_TABLE_NAME = 'resale_rofr_elections' THEN
    IF NEW.status <> 'active' THEN
      RETURN NEW;
    END IF;
    -- The offered co-owner confirming inside their own window.
    IF TG_OP = 'UPDATE' AND OLD.status = 'offered' AND EXISTS (
      SELECT 1 FROM public.resale_listings l
      WHERE l.id = NEW.listing_id AND l.offer_holder_key = NEW.holder_key AND l.offer_closes_at IS NOT NULL AND now() < l.offer_closes_at
    ) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.resale_listings l
    WHERE l.id = NEW.listing_id AND l.status = 'rofr_open' AND now() < l.rofr_closes_at
  ) THEN
    RAISE EXCEPTION 'The right of first refusal is not open' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Giving someone the founder role (run on its own, after the statements above have committed). Replace the id:
--   INSERT INTO public.user_roles (user_id, role) VALUES ('<the founder''s auth user id>', 'founder') ON CONFLICT DO NOTHING;
