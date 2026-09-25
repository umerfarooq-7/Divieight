-- Listing lock: once a pod is full (System Lock), through Closing-Ready and
-- after closing (Active), the seller can no longer edit or delete the listing,
-- its media or its data-room documents. Admins and server-side code (service
-- role) are unaffected. Safe to re-run.

CREATE OR REPLACE FUNCTION public.listing_is_locked(_property_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.properties
    WHERE id = _property_id
      AND listing_status IN ('system_lock', 'closing_ready', 'active')
  );
$$;

CREATE OR REPLACE FUNCTION public.enforce_listing_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _property_id uuid;
BEGIN
  -- Only end users acting through the API are restricted.
  IF auth.role() IS DISTINCT FROM 'authenticated' OR public.has_role(auth.uid(), 'admin') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'properties' THEN
    _property_id := OLD.id;
  ELSE
    _property_id := COALESCE(OLD.property_id, NEW.property_id);
  END IF;

  IF public.listing_is_locked(_property_id) THEN
    RAISE EXCEPTION 'This listing is locked: the pod is full, so the property can no longer be edited or deleted.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS listing_lock_properties ON public.properties;
CREATE TRIGGER listing_lock_properties
  BEFORE UPDATE OR DELETE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.enforce_listing_lock();

DROP TRIGGER IF EXISTS listing_lock_media ON public.property_media;
CREATE TRIGGER listing_lock_media
  BEFORE INSERT OR UPDATE OR DELETE ON public.property_media
  FOR EACH ROW EXECUTE FUNCTION public.enforce_listing_lock();

DROP TRIGGER IF EXISTS listing_lock_documents ON public.property_documents;
CREATE TRIGGER listing_lock_documents
  BEFORE INSERT OR UPDATE OR DELETE ON public.property_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_listing_lock();
