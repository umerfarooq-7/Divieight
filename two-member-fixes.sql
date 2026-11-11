-- Two-member accounts: the state filing record names every member. Run once in the Supabase SQL editor.
-- Safe to re-run. (The app works without it: the same roster is always written to the audit log; this
-- column keeps it on the entity's own record as well.)

ALTER TABLE public.entity_genesis ADD COLUMN IF NOT EXISTS filing_roster jsonb;
COMMENT ON COLUMN public.entity_genesis.filing_roster IS
  'The members named in the state filing, per Buyer Account, from the locked cap table: [{"buyerAccountId": "...", "members": ["Name One", "Name Two"]}]';


-- ---------------------------------------------------------------------------------------------------------
-- Same person = same identity document number. The database rule now matches the app's: the same ID number on
-- both members of an account is refused whatever name or birth date was typed (spacing, dashes and case
-- ignored). Replaces the function from account-members.sql; the trigger on it is unchanged.
-- ---------------------------------------------------------------------------------------------------------
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

    -- One identity document belongs to one person: the same ID number twice (spacing, dashes and case aside)
    -- is the same person, whatever name or birth date was typed.
    IF coalesce(regexp_replace(NEW.id_document_number, '[\s-]+', '', 'g'), '') <> '' AND EXISTS (
      SELECT 1 FROM public.account_members o
      WHERE o.buyer_account_id = NEW.buyer_account_id AND o.status = 'active' AND o.id <> NEW.id
        AND upper(regexp_replace(o.id_document_number, '[\s-]+', '', 'g')) = upper(regexp_replace(NEW.id_document_number, '[\s-]+', '', 'g'))
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
