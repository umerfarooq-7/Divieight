-- Joint reservations. Run once in the Supabase SQL editor, after co-buyer-links.sql. Safe to re-run.
--
-- Two linked co-buyers can take ONE share together. The share is reserved by the buyer who starts it (the initiator), exactly as
-- before: one pod_reservations row under their account, so the pod count, earnest money and closing funds are unchanged and the
-- initiator is the one who pays. The other buyer (the partner) is asked first; if they accept, they become the second holder of
-- that same share (joint_reservations). If they decline or do not answer, the share stays the initiator's alone.
--
-- Rules, enforced here whoever writes:
--  * one request and at most one joint holder per reservation
--  * a joint holder is a different account from the initiator
--  * a buyer can co-hold only one share per property
--  * clients can read their own rows; only divieight's server (service role) writes them

CREATE TABLE IF NOT EXISTS public.joint_reservation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.pod_reservations(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  initiator_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  partner_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  link_id uuid REFERENCES public.co_buyer_links(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  responded_at timestamptz,
  CONSTRAINT joint_requests_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  CONSTRAINT joint_requests_two_accounts_check CHECK (initiator_account_id <> partner_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS joint_requests_one_per_reservation ON public.joint_reservation_requests (reservation_id);
CREATE INDEX IF NOT EXISTS joint_requests_partner_pending ON public.joint_reservation_requests (partner_account_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS public.joint_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.pod_reservations(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  primary_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  partner_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  request_id uuid REFERENCES public.joint_reservation_requests(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_reason text,
  CONSTRAINT joint_reservations_status_check CHECK (status IN ('active', 'ended')),
  CONSTRAINT joint_reservations_two_accounts_check CHECK (primary_account_id <> partner_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS joint_reservations_one_per_reservation ON public.joint_reservations (reservation_id);
CREATE UNIQUE INDEX IF NOT EXISTS joint_reservations_one_per_partner_property ON public.joint_reservations (property_id, partner_account_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS joint_reservations_partner ON public.joint_reservations (partner_account_id) WHERE status = 'active';

ALTER TABLE public.joint_reservation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.joint_reservations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Buyers read their own joint requests" ON public.joint_reservation_requests;
CREATE POLICY "Buyers read their own joint requests" ON public.joint_reservation_requests FOR SELECT TO authenticated
  USING (
    initiator_account_id IN (SELECT id FROM public.buyer_accounts WHERE auth_user_id = auth.uid())
    OR partner_account_id IN (SELECT id FROM public.buyer_accounts WHERE auth_user_id = auth.uid())
  );
DROP POLICY IF EXISTS "Admins read joint requests" ON public.joint_reservation_requests;
CREATE POLICY "Admins read joint requests" ON public.joint_reservation_requests FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Buyers read their own joint reservations" ON public.joint_reservations;
CREATE POLICY "Buyers read their own joint reservations" ON public.joint_reservations FOR SELECT TO authenticated
  USING (
    primary_account_id IN (SELECT id FROM public.buyer_accounts WHERE auth_user_id = auth.uid())
    OR partner_account_id IN (SELECT id FROM public.buyer_accounts WHERE auth_user_id = auth.uid())
  );
DROP POLICY IF EXISTS "Admins read joint reservations" ON public.joint_reservations;
CREATE POLICY "Admins read joint reservations" ON public.joint_reservations FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

REVOKE ALL ON public.joint_reservation_requests FROM anon, authenticated;
REVOKE ALL ON public.joint_reservations FROM anon, authenticated;
GRANT SELECT ON public.joint_reservation_requests TO authenticated;
GRANT SELECT ON public.joint_reservations TO authenticated;
GRANT ALL ON public.joint_reservation_requests TO service_role;
GRANT ALL ON public.joint_reservations TO service_role;
