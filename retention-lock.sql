-- Retention Lock enforcement and exceptions. Run once in the Supabase SQL editor,
-- AFTER votes.sql. Safe to re-run. Only reads the lock columns on
-- cap_table_entries; the closing saga still decides when the lock starts.

CREATE TABLE IF NOT EXISTS public.retention_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  share_number integer NOT NULL CHECK (share_number BETWEEN 1 AND 8),
  requested_by_user_id uuid NOT NULL,
  exception_type text NOT NULL CHECK (exception_type IN ('hardship', 'unanimous_consent')),
  reason text NOT NULL,
  supporting_doc_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  vote_id uuid REFERENCES public.votes(id) ON DELETE SET NULL,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retention_exceptions_property_idx ON public.retention_exceptions (property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS retention_exceptions_vote_idx ON public.retention_exceptions (vote_id);
-- One open request per share at a time.
CREATE UNIQUE INDEX IF NOT EXISTS retention_exceptions_one_pending
  ON public.retention_exceptions (property_id, share_number) WHERE status = 'pending';

-- Locked until the expiry date unless the CURRENT holder has an approved
-- exception, so an exception never passes to whoever holds the share next.
-- Same rule as shareLock() in src/lib/retention.server.ts.
CREATE OR REPLACE FUNCTION public.is_share_locked(_property uuid, _share_number integer)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT now() < c.retention_lock_expires_at AND NOT EXISTS (
      SELECT 1 FROM public.retention_exceptions e
      WHERE e.property_id = c.property_id
        AND e.share_number = c.share_number
        AND e.status = 'approved'
        AND e.requested_by_user_id = CASE
          WHEN c.holder_type = 'retained_seller' THEN c.seller_id
          ELSE (SELECT b.auth_user_id FROM public.buyer_accounts b WHERE b.id = c.buyer_account_id)
        END
    )
    FROM public.cap_table_entries c
    WHERE c.property_id = _property AND c.share_number = _share_number
  ), false);
$$;
REVOKE ALL ON FUNCTION public.is_share_locked(uuid, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.is_share_locked(uuid, integer) TO authenticated, service_role;

-- For the Resale Shop listing RPC or trigger: raises unless the share can be listed.
CREATE OR REPLACE FUNCTION public.assert_share_listable(_property uuid, _share_number integer)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _expires timestamptz;
BEGIN
  SELECT c.retention_lock_expires_at INTO _expires
  FROM public.cap_table_entries c
  WHERE c.property_id = _property AND c.share_number = _share_number;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Share #% has not been issued on this property.', _share_number USING ERRCODE = 'check_violation';
  END IF;
  IF public.is_share_locked(_property, _share_number) THEN
    RAISE EXCEPTION 'Share #% is under the 12-month Retention Lock until %.', _share_number, to_char(_expires, 'FMMonth FMDD, YYYY')
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_share_listable(uuid, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.assert_share_listable(uuid, integer) TO authenticated, service_role;

-- Read-only for signed-in users: every write goes through the server functions.
GRANT SELECT ON public.retention_exceptions TO authenticated;
GRANT ALL ON public.retention_exceptions TO service_role;
ALTER TABLE public.retention_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "requester or admin reads retention exceptions" ON public.retention_exceptions;
CREATE POLICY "requester or admin reads retention exceptions" ON public.retention_exceptions
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR (requested_by_user_id = auth.uid() AND public.is_property_owner(auth.uid(), property_id))
  );
