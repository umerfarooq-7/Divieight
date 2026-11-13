-- Month 6 (late-arriving documents and the Final Acknowledgment Posture Record).
-- Run in the Supabase SQL editor AFTER due-diligence-gate.sql, report-delivery.sql, entity-genesis-stage2.sql (the Records Vault) and closing-saga.sql.
-- Safe to run again. Only adds two tables: nothing existing is changed.
--
--   * diligence_retriggers: when a Required document is added, or a new version supersedes one, after acknowledgments already exist, the gate re-closes
--     for the property (the gate is computed from the documents, so it re-closes by itself). This table records WHEN, for which document, and who still owed
--     the new item. It is evidence for the Posture Record. Never edited or deleted. Older acknowledgments are NOT touched: they stay recorded against
--     the version they were made on.
--   * acknowledgment_posture_records: the Final Acknowledgment Posture Record, made at the Closing Ping. One immutable, hashed record per property per
--     content (a new version only if the acknowledgments or documents changed). It lists every buyer account member and every tethered agent with each
--     Required document and version, when it was acknowledged, from what IP and device, by what method, and any re-triggers. Admin read only.

CREATE TABLE IF NOT EXISTS public.diligence_retriggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  prior_document_id uuid,
  kind text NOT NULL CHECK (kind IN ('new_required_document', 'new_version')),
  document_title text NOT NULL,
  content_hash text NOT NULL,
  -- True when acknowledgments of other documents already existed on the property: the gate re-closed on people who had acknowledged the rest.
  acknowledged_before boolean NOT NULL DEFAULT false,
  -- Who owed the new item when it arrived: [{buyer_account_id, members: [{account_member_id, name}], agent: {agent_id, name} | null}].
  owing jsonb NOT NULL DEFAULT '[]'::jsonb,
  triggered_by uuid,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id)
);
CREATE INDEX IF NOT EXISTS diligence_retriggers_property_idx ON public.diligence_retriggers (property_id, triggered_at);

CREATE OR REPLACE FUNCTION public.diligence_retriggers_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A re-trigger is a record: it is never edited or deleted.' USING ERRCODE = 'check_violation';
END;
$$;
DROP TRIGGER IF EXISTS diligence_retriggers_history ON public.diligence_retriggers;
CREATE TRIGGER diligence_retriggers_history BEFORE UPDATE OR DELETE ON public.diligence_retriggers FOR EACH ROW EXECUTE FUNCTION public.diligence_retriggers_guard();

CREATE TABLE IF NOT EXISTS public.acknowledgment_posture_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  -- A hash of the content without the time it was made: the same acknowledgments give the same content hash, so a retry changes nothing.
  content_hash text NOT NULL,
  data jsonb NOT NULL,
  -- The record's own hash (sha256 of data), the one the Audit Vault and the Records Vault carry.
  hash text NOT NULL,
  saga_key text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  -- The Records Vault row it was attached to (set once, by the saga's last step).
  vault_document_id uuid,
  UNIQUE (property_id, version)
);

CREATE OR REPLACE FUNCTION public.acknowledgment_posture_records_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A posture record is never deleted. A new version is a new record.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.property_id <> OLD.property_id OR NEW.version <> OLD.version OR NEW.content_hash <> OLD.content_hash OR NEW.data IS DISTINCT FROM OLD.data
     OR NEW.hash <> OLD.hash OR NEW.saga_key IS DISTINCT FROM OLD.saga_key OR NEW.generated_at <> OLD.generated_at THEN
    RAISE EXCEPTION 'A posture record is immutable.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.vault_document_id IS NOT NULL AND NEW.vault_document_id IS DISTINCT FROM OLD.vault_document_id THEN
    RAISE EXCEPTION 'A posture record''s vault copy is fixed once it is attached.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS acknowledgment_posture_records_history ON public.acknowledgment_posture_records;
CREATE TRIGGER acknowledgment_posture_records_history BEFORE UPDATE OR DELETE ON public.acknowledgment_posture_records FOR EACH ROW EXECUTE FUNCTION public.acknowledgment_posture_records_guard();

ALTER TABLE public.diligence_retriggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.acknowledgment_posture_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.diligence_retriggers, public.acknowledgment_posture_records FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.diligence_retriggers, public.acknowledgment_posture_records TO authenticated;
GRANT SELECT, INSERT ON public.diligence_retriggers TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.acknowledgment_posture_records TO service_role;

-- The Manager reads both. The posture record names every member with the IP and device they acknowledged from, so it is not shown to co-owners
-- (the co-owner Records Vault list leaves it out).
DROP POLICY IF EXISTS "the Manager reads re-triggers" ON public.diligence_retriggers;
CREATE POLICY "the Manager reads re-triggers" ON public.diligence_retriggers FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
DROP POLICY IF EXISTS "the Manager reads posture records" ON public.acknowledgment_posture_records;
CREATE POLICY "the Manager reads posture records" ON public.acknowledgment_posture_records FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

REVOKE ALL ON FUNCTION public.diligence_retriggers_guard(), public.acknowledgment_posture_records_guard() FROM PUBLIC, anon, authenticated;
