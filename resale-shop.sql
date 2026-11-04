-- Resale Shop, part 1. Run once in the Supabase SQL editor, AFTER retention-lock.sql.
-- Safe to re-run. Only adds tables; existing tables are untouched.

CREATE TABLE IF NOT EXISTS public.resale_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  share_number integer NOT NULL CHECK (share_number BETWEEN 1 AND 8),
  seller_holder_key text NOT NULL,
  seller_user_id uuid NOT NULL,
  asking_price numeric NOT NULL CHECK (asking_price > 0),
  status text NOT NULL DEFAULT 'rofr_open'
    CHECK (status IN ('rofr_open', 'rofr_exercised', 'open_market', 'sold', 'withdrawn', 'expired')),
  rofr_opens_at timestamptz NOT NULL DEFAULT now(),
  rofr_closes_at timestamptz NOT NULL,
  flat_fee numeric NOT NULL DEFAULT 500,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (rofr_closes_at = rofr_opens_at + interval '240 hours')
);
CREATE INDEX IF NOT EXISTS resale_listings_property_idx ON public.resale_listings (property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS resale_listings_status_idx ON public.resale_listings (status, rofr_closes_at);
-- A share can be on offer only once at a time.
CREATE UNIQUE INDEX IF NOT EXISTS resale_listings_one_live
  ON public.resale_listings (property_id, share_number)
  WHERE status IN ('rofr_open', 'rofr_exercised', 'open_market');

CREATE TABLE IF NOT EXISTS public.resale_rofr_elections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.resale_listings(id) ON DELETE CASCADE,
  holder_key text NOT NULL,
  user_id uuid,
  elected_at timestamptz NOT NULL DEFAULT now(),
  priority_rank_at_election integer,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'won', 'lost', 'withdrawn')),
  UNIQUE (listing_id, holder_key)
);

-- Internal consensus inside a multi-member Buyer Account. Members share the
-- account's login, so each position names the member it was recorded for.
CREATE TABLE IF NOT EXISTS public.resale_rofr_member_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.resale_listings(id) ON DELETE CASCADE,
  holder_key text NOT NULL,
  account_member_id uuid NOT NULL REFERENCES public.account_members(id) ON DELETE CASCADE,
  user_id uuid,
  position text NOT NULL CHECK (position IN ('exercise', 'decline')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, account_member_id)
);

CREATE TABLE IF NOT EXISTS public.resale_interest_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.resale_listings(id) ON DELETE CASCADE,
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, buyer_account_id)
);

-- A locked share can't be listed, whoever writes the row.
CREATE OR REPLACE FUNCTION public.enforce_resale_listable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_share_listable(NEW.property_id, NEW.share_number);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS resale_listings_listable ON public.resale_listings;
CREATE TRIGGER resale_listings_listable BEFORE INSERT ON public.resale_listings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_resale_listable();

-- Elections and positions only while the ROFR window is open, for every writer.
-- An election may still be closed out afterwards, by withdrawal or conflict resolution.
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
DROP TRIGGER IF EXISTS resale_elections_window ON public.resale_rofr_elections;
CREATE TRIGGER resale_elections_window BEFORE INSERT OR UPDATE ON public.resale_rofr_elections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rofr_window();
DROP TRIGGER IF EXISTS resale_positions_window ON public.resale_rofr_member_positions;
CREATE TRIGGER resale_positions_window BEFORE INSERT OR UPDATE ON public.resale_rofr_member_positions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rofr_window();

-- Read-only for signed-in users: every write goes through the server functions.
-- Open-market browsing also goes through the server, which leaves out the seller.
GRANT SELECT ON public.resale_listings, public.resale_rofr_elections, public.resale_rofr_member_positions, public.resale_interest_requests TO authenticated;
GRANT ALL ON public.resale_listings, public.resale_rofr_elections, public.resale_rofr_member_positions, public.resale_interest_requests TO service_role;
ALTER TABLE public.resale_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resale_rofr_elections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resale_rofr_member_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resale_interest_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "co-owners read resale listings" ON public.resale_listings;
CREATE POLICY "co-owners read resale listings" ON public.resale_listings
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR seller_user_id = auth.uid()
    OR public.is_property_owner(auth.uid(), property_id)
  );

DROP POLICY IF EXISTS "holders read own elections" ON public.resale_rofr_elections;
CREATE POLICY "holders read own elections" ON public.resale_rofr_elections
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.is_own_holder_key(auth.uid(), holder_key));

DROP POLICY IF EXISTS "holders read own rofr positions" ON public.resale_rofr_member_positions;
CREATE POLICY "holders read own rofr positions" ON public.resale_rofr_member_positions
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.is_own_holder_key(auth.uid(), holder_key));

DROP POLICY IF EXISTS "buyers read own resale interest" ON public.resale_interest_requests;
CREATE POLICY "buyers read own resale interest" ON public.resale_interest_requests
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR user_id = auth.uid());
