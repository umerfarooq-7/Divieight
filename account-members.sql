-- Second Account Member. Run once in the Supabase SQL editor. Safe to re-run.
-- Adds columns to account_members and signed_documents, and the rules below. Existing
-- columns and rows are kept; every existing member becomes 'active'.
--
-- Rules, enforced here whoever writes:
--  * at most 2 ACTIVE members per Buyer Account, and exactly one active 'primary'
--  * the two members never share an email, or the same name + date of birth + ID number
--  * a member row is never deleted; a removed member is frozen with its history
--  * after the Golden Ticket or the cap-table lock, only divieight (service role) can
--    add, edit or remove a member
--  * one person may be in several Buyer Accounts, never in two in the same pod
--  * a member-level signature must name an active member of the signing account

ALTER TABLE public.account_members
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS added_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  -- Needed to tell two people apart after their ID scans.
  ADD COLUMN IF NOT EXISTS id_document_number text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_members_status_check') THEN
    ALTER TABLE public.account_members ADD CONSTRAINT account_members_status_check CHECK (status IN ('active', 'removed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_members_removed_at_check') THEN
    ALTER TABLE public.account_members ADD CONSTRAINT account_members_removed_at_check CHECK ((status = 'removed') = (removed_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_members_role_check') THEN
    ALTER TABLE public.account_members ADD CONSTRAINT account_members_role_check CHECK (role IN ('primary', 'member'));
  END IF;
END $$;

-- The primary's email is the login's: fill it in so the same-email rule can see it.
UPDATE public.account_members m SET email = b.email
FROM public.buyer_accounts b
WHERE b.id = m.buyer_account_id AND m.role = 'primary' AND m.email IS NULL;

-- Exactly one active primary per account.
CREATE UNIQUE INDEX IF NOT EXISTS account_members_one_active_primary
  ON public.account_members (buyer_account_id) WHERE role = 'primary' AND status = 'active';
-- No email twice among an account's active members.
CREATE UNIQUE INDEX IF NOT EXISTS account_members_one_email_per_account
  ON public.account_members (buyer_account_id, lower(email)) WHERE status = 'active' AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_members_email_idx ON public.account_members (lower(email)) WHERE status = 'active';

-- Server code (service role) and the SQL editor are divieight; everyone else is a buyer.
CREATE OR REPLACE FUNCTION public.is_platform_writer()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_user IN ('service_role', 'postgres', 'supabase_admin');
$$;

-- Golden Ticket issued, or the account sits on a cap table that is locked.
CREATE OR REPLACE FUNCTION public.buyer_account_members_locked(_account uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT golden_ticket_issued FROM public.buyer_accounts WHERE id = _account), false)
      OR EXISTS (
        SELECT 1 FROM public.cap_table_entries c
        JOIN public.entity_genesis g ON g.property_id = c.property_id
        WHERE c.buyer_account_id = _account AND g.cap_table_locked_at IS NOT NULL
      );
$$;

-- The same person on two accounts that share a pod: by email, or by name + DOB + ID number.
CREATE OR REPLACE FUNCTION public.person_in_another_account_of_pod(_account uuid, _email text, _name text, _dob date, _id_number text, _property uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- A buyer can only ever ask about their own account.
  SELECT (public.is_platform_writer() OR EXISTS (SELECT 1 FROM public.buyer_accounts b WHERE b.id = _account AND b.auth_user_id = auth.uid()))
  AND EXISTS (
    SELECT 1
    FROM public.account_members other
    JOIN public.pod_reservations theirs ON theirs.buyer_account_id = other.buyer_account_id AND theirs.status = 'reserved'
    WHERE other.buyer_account_id <> _account
      AND other.status = 'active'
      AND (
        (_email IS NOT NULL AND lower(other.email) = lower(_email))
        OR (_id_number IS NOT NULL AND _dob IS NOT NULL AND other.date_of_birth = _dob
            AND upper(other.id_document_number) = upper(_id_number) AND lower(btrim(other.full_name)) = lower(btrim(_name)))
      )
      AND (
        (_property IS NOT NULL AND theirs.property_id = _property)
        OR EXISTS (SELECT 1 FROM public.pod_reservations mine WHERE mine.buyer_account_id = _account AND mine.status = 'reserved' AND mine.property_id = theirs.property_id)
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.account_members_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  platform boolean := public.is_platform_writer();
  others integer;
  account_email text;
  member_fields_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Account members are never deleted. Remove them instead.' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.role = 'primary' AND NEW.email IS NULL THEN
    SELECT email INTO NEW.email FROM public.buyer_accounts WHERE id = NEW.buyer_account_id;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'removed' AND NOT platform THEN
      RAISE EXCEPTION 'This member was removed from the account.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role AND NOT platform THEN
      RAISE EXCEPTION 'A member''s role can''t be changed.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.buyer_account_id IS DISTINCT FROM OLD.buyer_account_id THEN
      RAISE EXCEPTION 'A member can''t move to another account.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- After the Golden Ticket or the cap-table lock, members change only through divieight.
  member_fields_changed := TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.email IS DISTINCT FROM OLD.email OR NEW.phone IS DISTINCT FROM OLD.phone
    OR (NEW.role = 'member' AND NEW.full_name IS DISTINCT FROM OLD.full_name);
  IF member_fields_changed AND NOT platform AND NEW.role = 'member' AND public.buyer_account_members_locked(NEW.buyer_account_id) THEN
    RAISE EXCEPTION 'Account members can''t be changed after the Golden Ticket is issued. Contact divieight support.' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'active' THEN
    PERFORM pg_advisory_xact_lock(hashtext('account_members:' || NEW.buyer_account_id::text));
    SELECT count(*) INTO others FROM public.account_members
    WHERE buyer_account_id = NEW.buyer_account_id AND status = 'active' AND id <> NEW.id;
    IF others >= 2 THEN
      RAISE EXCEPTION 'A Buyer Account can have at most two members.' USING ERRCODE = 'check_violation';
    END IF;

    SELECT email INTO account_email FROM public.buyer_accounts WHERE id = NEW.buyer_account_id;
    IF NEW.email IS NOT NULL AND (
      (NEW.role <> 'primary' AND lower(NEW.email) = lower(account_email))
      OR EXISTS (SELECT 1 FROM public.account_members o WHERE o.buyer_account_id = NEW.buyer_account_id AND o.status = 'active' AND o.id <> NEW.id AND lower(o.email) = lower(NEW.email))
    ) THEN
      RAISE EXCEPTION 'Each member needs their own email address.' USING ERRCODE = 'unique_violation';
    END IF;

    IF NEW.id_document_number IS NOT NULL AND NEW.date_of_birth IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.account_members o
      WHERE o.buyer_account_id = NEW.buyer_account_id AND o.status = 'active' AND o.id <> NEW.id
        AND o.date_of_birth = NEW.date_of_birth
        AND upper(o.id_document_number) = upper(NEW.id_document_number)
        AND lower(btrim(o.full_name)) = lower(btrim(NEW.full_name))
    ) THEN
      RAISE EXCEPTION 'These details match the other member on this account. Each member must be a different person.' USING ERRCODE = 'unique_violation';
    END IF;

    IF public.person_in_another_account_of_pod(NEW.buyer_account_id, NEW.email, NEW.full_name, NEW.date_of_birth, NEW.id_document_number) THEN
      RAISE EXCEPTION 'This person already belongs to another Buyer Account in the same pod.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS account_members_guard ON public.account_members;
CREATE TRIGGER account_members_guard BEFORE INSERT OR UPDATE OR DELETE ON public.account_members
  FOR EACH ROW EXECUTE FUNCTION public.account_members_guard();

-- Never hard-delete: buyers lose the delete policy too.
DROP POLICY IF EXISTS "Buyers remove their own account members" ON public.account_members;
REVOKE DELETE ON public.account_members FROM authenticated;

-- A reservation can't put the same person in a pod twice through two accounts.
CREATE OR REPLACE FUNCTION public.pod_reservations_one_person_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'reserved' AND EXISTS (
    SELECT 1 FROM public.account_members m
    WHERE m.buyer_account_id = NEW.buyer_account_id AND m.status = 'active'
      AND public.person_in_another_account_of_pod(NEW.buyer_account_id, m.email, m.full_name, m.date_of_birth, m.id_document_number, NEW.property_id)
  ) THEN
    RAISE EXCEPTION 'A member of this account already belongs to another Buyer Account in this pod.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pod_reservations_one_person_guard ON public.pod_reservations;
CREATE TRIGGER pod_reservations_one_person_guard BEFORE INSERT OR UPDATE OF status ON public.pod_reservations
  FOR EACH ROW EXECUTE FUNCTION public.pod_reservations_one_person_guard();

-- Member-level signatures name the member who signed.
ALTER TABLE public.signed_documents
  ADD COLUMN IF NOT EXISTS account_member_id uuid REFERENCES public.account_members(id);
CREATE INDEX IF NOT EXISTS signed_documents_member_idx ON public.signed_documents (account_member_id) WHERE account_member_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.signed_documents_member_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.document_type IN ('HOLD_HARMLESS', 'block_5_independent_advice') AND NEW.buyer_account_id IS NOT NULL AND NEW.account_member_id IS NULL THEN
    RAISE EXCEPTION 'This signature must name the Account Member who signed.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.account_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.account_members m
    WHERE m.id = NEW.account_member_id AND m.buyer_account_id = NEW.buyer_account_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'That member isn''t an active member of this account.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS signed_documents_member_guard ON public.signed_documents;
CREATE TRIGGER signed_documents_member_guard BEFORE INSERT ON public.signed_documents
  FOR EACH ROW EXECUTE FUNCTION public.signed_documents_member_guard();

REVOKE ALL ON FUNCTION public.buyer_account_members_locked(uuid) FROM public, anon;
-- The member guard runs as the buyer, so the buyer needs these; each only answers about the caller's own account.
REVOKE ALL ON FUNCTION public.person_in_another_account_of_pod(uuid, text, text, date, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.person_in_another_account_of_pod(uuid, text, text, date, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.buyer_account_members_locked(uuid) TO authenticated, service_role;
