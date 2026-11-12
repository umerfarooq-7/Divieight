-- divieight — Month 6, Prompt 5: co-owners flag transactions, the Manager resolves them.
--
-- Run in the Supabase SQL editor AFTER bookkeeping.sql, capital-accounts.sql and books.sql. Safe to run again.
--
--   * coowner_inquiries: a co-owner asks a question about an LLC transaction, or suggests a recategorization.
--   * raise_inquiry / answer_inquiry / reject_inquiry / resolve_inquiry: the only ways in. Resolving can post a correction
--     through the Prompt 4 functions (a reversing entry plus a corrected one), and the new entry is linked in
--     resulting_entry_id. Every step is written to the Audit Vault.
--   * An inquiry is a note beside the books. Nothing reads it to decide whether a statement, a vote, a payment or any other
--     Ownership Function is available: it can never block one.

CREATE TABLE IF NOT EXISTS public.coowner_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id),
  journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id),
  -- The capital account that asked: a Buyer Account (one, even with two people) or a retained seller.
  raised_by_member_id uuid NOT NULL,
  raised_by_user_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('clarification', 'recategorize')),
  message text NOT NULL CHECK (btrim(message) <> '' AND char_length(message) <= 2000),
  -- For a recategorization: the account the co-owner thinks it belongs on (a chart code).
  suggested_account_code text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'resolved', 'rejected')),
  manager_response text,
  responded_by uuid,
  responded_at timestamptz,
  resolved_by uuid,
  resolved_at timestamptz,
  resulting_entry_id uuid REFERENCES public.journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'open' OR (manager_response IS NOT NULL AND btrim(manager_response) <> '')),
  CHECK ((status IN ('resolved', 'rejected')) = (resolved_at IS NOT NULL)),
  CHECK (resulting_entry_id IS NULL OR status = 'resolved')
);
CREATE INDEX IF NOT EXISTS coowner_inquiries_property_idx ON public.coowner_inquiries (property_id, status, created_at);
CREATE INDEX IF NOT EXISTS coowner_inquiries_member_idx ON public.coowner_inquiries (raised_by_member_id, property_id);
CREATE INDEX IF NOT EXISTS coowner_inquiries_entry_idx ON public.coowner_inquiries (journal_entry_id);

-- What was asked never changes; an inquiry is never deleted; a settled one stays settled.
CREATE OR REPLACE FUNCTION public.coowner_inquiries_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'An inquiry is never deleted.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.property_id <> OLD.property_id OR NEW.journal_entry_id <> OLD.journal_entry_id OR NEW.raised_by_member_id <> OLD.raised_by_member_id
     OR NEW.raised_by_user_id <> OLD.raised_by_user_id OR NEW.type <> OLD.type OR NEW.message <> OLD.message
     OR NEW.suggested_account_code IS DISTINCT FROM OLD.suggested_account_code OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'What a co-owner asked can''t be changed.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('resolved', 'rejected') THEN
    RAISE EXCEPTION 'A settled inquiry stays settled. Raise a new one.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS coowner_inquiries_guard_trg ON public.coowner_inquiries;
CREATE TRIGGER coowner_inquiries_guard_trg BEFORE UPDATE OR DELETE ON public.coowner_inquiries FOR EACH ROW EXECUTE FUNCTION public.coowner_inquiries_guard();
DROP TRIGGER IF EXISTS coowner_inquiries_truncate_guard ON public.coowner_inquiries;
CREATE TRIGGER coowner_inquiries_truncate_guard BEFORE TRUNCATE ON public.coowner_inquiries FOR EACH STATEMENT EXECUTE FUNCTION public.coowner_inquiries_guard();

ALTER TABLE public.coowner_inquiries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coowner_inquiries FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.coowner_inquiries TO authenticated, service_role;
-- The Manager reads all; a co-owner reads only their own, never anyone else's, and only on a property they own.
DROP POLICY IF EXISTS "the Manager and the asker read inquiries" ON public.coowner_inquiries;
CREATE POLICY "the Manager and the asker read inquiries" ON public.coowner_inquiries FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR (raised_by_user_id = auth.uid() AND public.is_property_owner(auth.uid(), property_id)));

-- ---------------------------------------------------------------------------------------------------------
-- Raising
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.raise_inquiry(_property uuid, _entry uuid, _user uuid, _type text, _message text, _suggested_code text DEFAULT NULL, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  member uuid;
  entry public.journal_entries%ROWTYPE;
  note text := NULLIF(btrim(COALESCE(_message, '')), '');
  acct_code text := NULLIF(btrim(COALESCE(_suggested_code, '')), '');
  ver public.coa_versions%ROWTYPE;
  new_id uuid;
BEGIN
  IF _user IS NULL THEN
    RAISE EXCEPTION 'Sign in to ask a question.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only an owner of THIS property: asking about another property's books is refused.
  member := public.capital_member_key(_property, _user);
  IF member IS NULL THEN
    RAISE EXCEPTION 'You don''t have ownership in that property.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO entry FROM public.journal_entries WHERE id = _entry;
  IF NOT FOUND OR entry.property_id <> _property THEN
    RAISE EXCEPTION 'That transaction isn''t in this property''s books.' USING ERRCODE = 'no_data_found';
  END IF;
  IF _type NOT IN ('clarification', 'recategorize') THEN
    RAISE EXCEPTION 'Choose a question or a recategorization.' USING ERRCODE = 'check_violation';
  END IF;
  IF note IS NULL THEN
    RAISE EXCEPTION 'Say what you would like to know or change.' USING ERRCODE = 'check_violation';
  END IF;
  IF char_length(note) > 2000 THEN
    RAISE EXCEPTION 'Keep it under 2,000 characters.' USING ERRCODE = 'check_violation';
  END IF;
  IF _type = 'recategorize' THEN
    IF acct_code IS NULL THEN
      RAISE EXCEPTION 'Say which account it should be on.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO ver FROM public.coa_versions ORDER BY version DESC LIMIT 1;
    IF NOT EXISTS (SELECT 1 FROM public.coa_accounts WHERE version_id = ver.id AND code = acct_code AND NOT is_member_control) THEN
      RAISE EXCEPTION 'That isn''t an account on the chart.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    acct_code := NULL;
  END IF;
  IF (SELECT count(*) FROM public.coowner_inquiries WHERE property_id = _property AND raised_by_member_id = member AND status IN ('open', 'answered')) >= 25 THEN
    RAISE EXCEPTION 'You have a lot of open questions on this home. Please wait for the Manager to catch up.' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.coowner_inquiries (property_id, journal_entry_id, raised_by_member_id, raised_by_user_id, type, message, suggested_account_code)
  VALUES (_property, _entry, member, _user, _type, note, acct_code) RETURNING id INTO new_id;
  PERFORM public.ledger_audit(_user, 'inquiry.raised', new_id, jsonb_build_object('property_id', _property, 'journal_entry_id', _entry, 'type', _type, 'member', member, 'suggested_account', acct_code, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN new_id;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- The Manager's answers
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.answer_inquiry(_id uuid, _actor uuid, _response text, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q public.coowner_inquiries%ROWTYPE;
  text_ text := NULLIF(btrim(COALESCE(_response, '')), '');
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can answer an inquiry.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF text_ IS NULL THEN
    RAISE EXCEPTION 'Write the answer.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO q FROM public.coowner_inquiries WHERE id = _id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inquiry not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF q.status IN ('resolved', 'rejected') THEN
    RAISE EXCEPTION 'This inquiry is already %.', q.status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.coowner_inquiries SET status = 'answered', manager_response = text_, responded_by = _actor, responded_at = clock_timestamp() WHERE id = _id;
  PERFORM public.ledger_audit(_actor, 'inquiry.answered', _id, jsonb_build_object('property_id', q.property_id, 'journal_entry_id', q.journal_entry_id, 'response', text_, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_inquiry(_id uuid, _actor uuid, _response text, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q public.coowner_inquiries%ROWTYPE;
  text_ text := NULLIF(btrim(COALESCE(_response, '')), '');
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can reject an inquiry.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF text_ IS NULL THEN
    RAISE EXCEPTION 'Say why this suggestion isn''t being made.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO q FROM public.coowner_inquiries WHERE id = _id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inquiry not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF q.status IN ('resolved', 'rejected') THEN
    RAISE EXCEPTION 'This inquiry is already %.', q.status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.coowner_inquiries SET status = 'rejected', manager_response = text_, responded_by = _actor, responded_at = clock_timestamp(), resolved_by = _actor, resolved_at = clock_timestamp() WHERE id = _id;
  PERFORM public.ledger_audit(_actor, 'inquiry.rejected', _id, jsonb_build_object('property_id', q.property_id, 'journal_entry_id', q.journal_entry_id, 'response', text_, 'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
END;
$$;

-- Resolve an inquiry, optionally by posting a correction through the Prompt 4 functions. _correction:
--   { kind: 'recategorize' | 'capitalize' | 'reverse', mapping: { "<line id>": "<code>" }, reason, entry_date, is_adjustment, adjustment_reason }
-- If the correction is refused (a closed period, say) nothing changes: the inquiry stays as it was.
CREATE OR REPLACE FUNCTION public.resolve_inquiry(_id uuid, _actor uuid, _response text, _correction jsonb DEFAULT NULL, _meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q public.coowner_inquiries%ROWTYPE;
  text_ text := NULLIF(btrim(COALESCE(_response, '')), '');
  kind text := _correction->>'kind';
  why text;
  cmeta jsonb;
  done jsonb;
  resulting uuid;
BEGIN
  IF _actor IS NULL OR NOT public.has_role(_actor, 'admin') THEN
    RAISE EXCEPTION 'Only the Manager can resolve an inquiry.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF text_ IS NULL THEN
    RAISE EXCEPTION 'Write the response the co-owner will see.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO q FROM public.coowner_inquiries WHERE id = _id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inquiry not found.' USING ERRCODE = 'no_data_found';
  END IF;
  IF q.status IN ('resolved', 'rejected') THEN
    RAISE EXCEPTION 'This inquiry is already %.', q.status USING ERRCODE = 'check_violation';
  END IF;

  IF _correction IS NOT NULL AND kind IS NOT NULL THEN
    why := COALESCE(NULLIF(btrim(COALESCE(_correction->>'reason', '')), ''), 'Co-owner inquiry: ' || left(q.message, 120));
    cmeta := jsonb_build_object('entry_date', _correction->>'entry_date', 'is_adjustment', COALESCE((_correction->>'is_adjustment')::boolean, false), 'adjustment_reason', _correction->>'adjustment_reason',
                                'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent');
    IF kind = 'recategorize' THEN
      done := public.recategorize_entry(q.journal_entry_id, COALESCE(_correction->'mapping', '{}'::jsonb), why, _actor, cmeta);
      resulting := (done->>'corrected_entry_id')::uuid;
    ELSIF kind = 'capitalize' THEN
      done := public.capitalize_entry(q.journal_entry_id, why, _actor, cmeta);
      resulting := (done->>'corrected_entry_id')::uuid;
    ELSIF kind = 'reverse' THEN
      resulting := public.reverse_entry(q.journal_entry_id, why, cmeta || jsonb_build_object('created_by', _actor));
    ELSE
      RAISE EXCEPTION 'Choose recategorize, capitalize or reverse.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE public.coowner_inquiries SET status = 'resolved', manager_response = text_, responded_by = _actor, responded_at = clock_timestamp(),
    resolved_by = _actor, resolved_at = clock_timestamp(), resulting_entry_id = resulting WHERE id = _id;
  PERFORM public.ledger_audit(_actor, 'inquiry.resolved', _id, jsonb_build_object('property_id', q.property_id, 'journal_entry_id', q.journal_entry_id, 'response', text_, 'correction', kind, 'resulting_entry_id', resulting,
    'ip_address', _meta->>'ip_address', 'user_agent', _meta->>'user_agent'));
  RETURN jsonb_build_object('resulting_entry_id', resulting);
END;
$$;

REVOKE ALL ON FUNCTION public.raise_inquiry(uuid, uuid, uuid, text, text, text, jsonb), public.answer_inquiry(uuid, uuid, text, jsonb), public.reject_inquiry(uuid, uuid, text, jsonb),
  public.resolve_inquiry(uuid, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raise_inquiry(uuid, uuid, uuid, text, text, text, jsonb), public.answer_inquiry(uuid, uuid, text, jsonb), public.reject_inquiry(uuid, uuid, text, jsonb),
  public.resolve_inquiry(uuid, uuid, text, jsonb, jsonb) TO service_role;
