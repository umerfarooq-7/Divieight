-- The Conversion Event (Module 20): PRA executed AND PEF ($2,570) cleared, both required.
-- Run once in the Supabase SQL editor, AFTER agent-qr-attribution.sql. Safe to re-run.
--
-- Read-only towards the existing flows: the triggers on signed_documents and
-- buyer_enrollment_payments can never fail a signature or a payment. If one hits a
-- problem it logs a warning and the hourly sync_conversion_events() catches up.
--
-- The PRA and the PEF belong to a buyer, not to a home, so a buyer has one row:
-- property_id is the PRA's property if it names one, otherwise their first reservation.

CREATE TABLE IF NOT EXISTS public.conversion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id uuid NOT NULL REFERENCES public.buyer_accounts(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.properties(id) ON DELETE SET NULL,
  agent_attribution_id uuid REFERENCES public.buyer_attribution(id) ON DELETE SET NULL,
  pra_executed_at timestamptz,
  pef_cleared_at timestamptz,
  converted_at timestamptz,
  status text NOT NULL DEFAULT 'partial' CHECK (status IN ('partial', 'converted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pra_executed_at IS NOT NULL OR pef_cleared_at IS NOT NULL),
  -- 'converted' is only ever both, at the later of the two.
  CHECK (
    (status = 'converted' AND pra_executed_at IS NOT NULL AND pef_cleared_at IS NOT NULL AND converted_at = GREATEST(pra_executed_at, pef_cleared_at))
    OR (status = 'partial' AND converted_at IS NULL AND (pra_executed_at IS NULL OR pef_cleared_at IS NULL))
  )
);
-- Unique(buyer_account_id, property_id), counting an empty property_id as a value.
CREATE UNIQUE INDEX IF NOT EXISTS conversion_events_buyer_property
  ON public.conversion_events (buyer_account_id, COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS conversion_events_status_idx ON public.conversion_events (status, converted_at DESC);

-- Brings one buyer's row up to date. Safe to repeat: dates already recorded never move.
CREATE OR REPLACE FUNCTION public.sync_conversion_event(_buyer uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing public.conversion_events%ROWTYPE;
  pra timestamptz;
  pra_property uuid;
  pef timestamptz;
  first_reservation uuid;
  stamp uuid;
  final_pra timestamptz;
  final_pef timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('conversion_event:' || _buyer::text));

  SELECT created_at, property_id INTO pra, pra_property FROM public.signed_documents
  WHERE buyer_account_id = _buyer AND document_type = 'PRA' ORDER BY created_at ASC LIMIT 1;
  SELECT MIN(updated_at) INTO pef FROM public.buyer_enrollment_payments
  WHERE buyer_account_id = _buyer AND status = 'paid';

  SELECT * INTO existing FROM public.conversion_events WHERE buyer_account_id = _buyer ORDER BY created_at ASC LIMIT 1;
  final_pra := COALESCE(existing.pra_executed_at, pra);
  final_pef := COALESCE(existing.pef_cleared_at, pef);
  IF final_pra IS NULL AND final_pef IS NULL THEN
    RETURN;
  END IF;

  SELECT property_id INTO first_reservation FROM public.pod_reservations
  WHERE buyer_account_id = _buyer ORDER BY reserved_at ASC LIMIT 1;
  SELECT s.id INTO stamp FROM public.buyer_attribution s
  JOIN public.buyer_accounts b ON b.auth_user_id = s.buyer_user_id
  WHERE b.id = _buyer;

  IF existing.id IS NULL THEN
    INSERT INTO public.conversion_events (buyer_account_id, property_id, agent_attribution_id, pra_executed_at, pef_cleared_at, converted_at, status)
    VALUES (
      _buyer, COALESCE(pra_property, first_reservation), stamp, final_pra, final_pef,
      CASE WHEN final_pra IS NOT NULL AND final_pef IS NOT NULL THEN GREATEST(final_pra, final_pef) END,
      CASE WHEN final_pra IS NOT NULL AND final_pef IS NOT NULL THEN 'converted' ELSE 'partial' END
    );
  ELSE
    UPDATE public.conversion_events
    SET property_id = COALESCE(property_id, pra_property, first_reservation),
        agent_attribution_id = COALESCE(agent_attribution_id, stamp),
        pra_executed_at = final_pra,
        pef_cleared_at = final_pef,
        converted_at = CASE WHEN final_pra IS NOT NULL AND final_pef IS NOT NULL THEN GREATEST(final_pra, final_pef) END,
        status = CASE WHEN final_pra IS NOT NULL AND final_pef IS NOT NULL THEN 'converted' ELSE 'partial' END
    WHERE id = existing.id;
  END IF;
END;
$$;

-- Hourly and on demand from /admin/conversions. Picks up history and anything a trigger missed.
CREATE OR REPLACE FUNCTION public.sync_conversion_events()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  buyer uuid;
  processed integer := 0;
BEGIN
  FOR buyer IN
    SELECT buyer_account_id FROM public.signed_documents WHERE document_type = 'PRA' AND buyer_account_id IS NOT NULL
    UNION
    SELECT buyer_account_id FROM public.buyer_enrollment_payments WHERE status = 'paid'
    UNION
    SELECT buyer_account_id FROM public.conversion_events
  LOOP
    PERFORM public.sync_conversion_event(buyer);
    processed := processed + 1;
  END LOOP;
  RETURN jsonb_build_object(
    'processed', processed,
    'converted', (SELECT count(*) FROM public.conversion_events WHERE status = 'converted'),
    'partial', (SELECT count(*) FROM public.conversion_events WHERE status = 'partial')
  );
END;
$$;

-- The hooks. Never let a problem here reach the signature or the payment.
CREATE OR REPLACE FUNCTION public.conversion_on_pra()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.sync_conversion_event(NEW.buyer_account_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'conversion_on_pra: % (the hourly sync will catch up)', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.conversion_on_pef()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    PERFORM public.sync_conversion_event(NEW.buyer_account_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'conversion_on_pef: % (the hourly sync will catch up)', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

-- A stamp written after the buyer's row exists still reaches it.
CREATE OR REPLACE FUNCTION public.conversion_on_stamp()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    UPDATE public.conversion_events c
    SET agent_attribution_id = NEW.id
    FROM public.buyer_accounts b
    WHERE b.auth_user_id = NEW.buyer_user_id AND c.buyer_account_id = b.id AND c.agent_attribution_id IS NULL;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'conversion_on_stamp: % (the hourly sync will catch up)', SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS conversion_after_pra ON public.signed_documents;
CREATE TRIGGER conversion_after_pra AFTER INSERT ON public.signed_documents
  FOR EACH ROW WHEN (NEW.document_type = 'PRA' AND NEW.buyer_account_id IS NOT NULL)
  EXECUTE FUNCTION public.conversion_on_pra();

DROP TRIGGER IF EXISTS conversion_after_pef ON public.buyer_enrollment_payments;
CREATE TRIGGER conversion_after_pef AFTER INSERT OR UPDATE OF status ON public.buyer_enrollment_payments
  FOR EACH ROW WHEN (NEW.status = 'paid')
  EXECUTE FUNCTION public.conversion_on_pef();

DROP TRIGGER IF EXISTS conversion_after_stamp ON public.buyer_attribution;
CREATE TRIGGER conversion_after_stamp AFTER INSERT ON public.buyer_attribution
  FOR EACH ROW EXECUTE FUNCTION public.conversion_on_stamp();

REVOKE ALL ON FUNCTION public.sync_conversion_event(uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_conversion_events() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversion_on_pra() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversion_on_pef() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversion_on_stamp() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_conversion_event(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_conversion_events() TO service_role;

-- Admins only.
GRANT SELECT ON public.conversion_events TO authenticated;
GRANT ALL ON public.conversion_events TO service_role;
ALTER TABLE public.conversion_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admins read conversion events" ON public.conversion_events;
CREATE POLICY "admins read conversion events" ON public.conversion_events
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- History: every buyer who has already signed or paid.
SELECT public.sync_conversion_events();
