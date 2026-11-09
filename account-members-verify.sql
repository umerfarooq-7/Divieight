-- Checks the second-member rules on the REAL database. Run in the Supabase SQL editor
-- AFTER account-members.sql. It changes nothing: every test runs inside a block that is
-- rolled back at the end, and the result is a table of PASS / FAIL rows.
--
-- It borrows one existing buyer account that has a single active member and no Golden
-- Ticket, and one other account, acting as that buyer through row-level security.

CREATE OR REPLACE FUNCTION pg_temp.verify_account_members()
RETURNS TABLE (step text, result text, detail text)
LANGUAGE plpgsql
AS $$
DECLARE
  names text[] := '{}';
  results text[] := '{}';
  details text[] := '{}';
  acc uuid; uid uuid; acc_email text; primary_id uuid;
  other_acc uuid; other_member uuid;
  m2 uuid; n integer; msg text;
BEGIN
  SELECT b.id, b.auth_user_id, b.email INTO acc, uid, acc_email
  FROM public.buyer_accounts b
  WHERE NOT b.golden_ticket_issued
    AND (SELECT count(*) FROM public.account_members m WHERE m.buyer_account_id = b.id AND m.status = 'active') = 1
  LIMIT 1;
  SELECT m.buyer_account_id, m.id INTO other_acc, other_member
  FROM public.account_members m WHERE m.buyer_account_id <> acc AND m.status = 'active' LIMIT 1;
  IF acc IS NULL OR other_acc IS NULL THEN
    RETURN QUERY SELECT 'setup'::text, 'SKIPPED'::text, 'Needs one buyer account with a single member and no Golden Ticket, plus one other account.'::text;
    RETURN;
  END IF;
  SELECT id INTO primary_id FROM public.account_members WHERE buyer_account_id = acc AND status = 'active';

  BEGIN
    PERFORM set_config('request.jwt.claim.sub', uid::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);

    -- (5) An existing single-member account keeps working.
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.account_members WHERE buyer_account_id = acc;
    UPDATE public.account_members SET updated_at = now() WHERE id = primary_id;
    RESET ROLE;
    names := array_append(names, ('(5) single-member account still reads and updates its member')::text); results := array_append(results, (CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END)::text); details := array_append(details, (('rows seen: ' || n))::text);

    -- Add a second member as the buyer.
    SET LOCAL ROLE authenticated;
    INSERT INTO public.account_members (buyer_account_id, full_name, role, email)
    VALUES (acc, 'Verify Second', 'member', 'verify-second-' || substr(md5(random()::text), 1, 8) || '@example.invalid') RETURNING id INTO m2;
    RESET ROLE;
    names := array_append(names, ('second member can be added')::text); results := array_append(results, ('PASS')::text); details := array_append(details, ('')::text);

    -- (1) A third active member is refused, as the buyer and as the server.
    BEGIN
      SET LOCAL ROLE authenticated;
      INSERT INTO public.account_members (buyer_account_id, full_name, role, email) VALUES (acc, 'Verify Third', 'member', 'verify-third@example.invalid');
      RESET ROLE;
      names := array_append(names, ('(1) third member refused (buyer)')::text); results := array_append(results, ('FAIL')::text); details := array_append(details, ('insert succeeded')::text);
    EXCEPTION WHEN OTHERS THEN
      names := array_append(names, ('(1) third member refused (buyer)')::text); results := array_append(results, (CASE WHEN SQLERRM ILIKE '%at most two%' THEN 'PASS' ELSE 'FAIL' END)::text); details := array_append(details, (SQLERRM)::text);
    END;
    BEGIN
      INSERT INTO public.account_members (buyer_account_id, full_name, role, email) VALUES (acc, 'Verify Third', 'member', 'verify-third@example.invalid');
      names := array_append(names, ('(1) third member refused (server)')::text); results := array_append(results, ('FAIL')::text); details := array_append(details, ('insert succeeded')::text);
    EXCEPTION WHEN OTHERS THEN
      names := array_append(names, ('(1) third member refused (server)')::text); results := array_append(results, (CASE WHEN SQLERRM ILIKE '%at most two%' THEN 'PASS' ELSE 'FAIL' END)::text); details := array_append(details, (SQLERRM)::text);
    END;

    -- (2) A second active primary is refused.
    BEGIN
      UPDATE public.account_members SET role = 'primary' WHERE id = m2;
      names := array_append(names, ('(2) second primary refused')::text); results := array_append(results, ('FAIL')::text); details := array_append(details, ('update succeeded')::text);
    EXCEPTION WHEN OTHERS THEN
      names := array_append(names, ('(2) second primary refused')::text); results := array_append(results, (CASE WHEN SQLSTATE = '23505' THEN 'PASS' ELSE 'FAIL' END)::text); details := array_append(details, (SQLERRM)::text);
    END;

    -- (3) The same email can't fill both slots.
    BEGIN
      SET LOCAL ROLE authenticated;
      UPDATE public.account_members SET email = upper(acc_email) WHERE id = m2;
      RESET ROLE;
      names := array_append(names, ('(3) same email refused')::text); results := array_append(results, ('FAIL')::text); details := array_append(details, ('update succeeded')::text);
    EXCEPTION WHEN OTHERS THEN
      names := array_append(names, ('(3) same email refused')::text); results := array_append(results, (CASE WHEN SQLERRM ILIKE '%own email%' OR SQLSTATE = '23505' THEN 'PASS' ELSE 'FAIL' END)::text); details := array_append(details, (SQLERRM)::text);
    END;

    -- (4) Another account's member id is refused.
    BEGIN
      SET LOCAL ROLE authenticated;
      INSERT INTO public.signed_documents (buyer_account_id, account_member_id, document_type, document_version, signed_name)
      VALUES (acc, other_member, 'HOLD_HARMLESS', 'verify', 'Someone Else');
      RESET ROLE;
      names := array_append(names, ('(4) another account''s member refused on a signature')::text); results := array_append(results, ('FAIL')::text); details := array_append(details, ('insert succeeded')::text);
    EXCEPTION WHEN OTHERS THEN
      names := array_append(names, ('(4) another account''s member refused on a signature')::text); results := array_append(results, (CASE WHEN SQLERRM ILIKE '%active member of this account%' THEN 'PASS' ELSE 'FAIL' END)::text); details := array_append(details, (SQLERRM)::text);
    END;
    SET LOCAL ROLE authenticated;
    UPDATE public.account_members SET full_name = full_name WHERE id = other_member;
    GET DIAGNOSTICS n = ROW_COUNT;
    RESET ROLE;
    names := array_append(names, ('(4) another account''s member can''t be updated')::text); results := array_append(results, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END)::text); details := array_append(details, (('rows changed: ' || n))::text);

    -- (7) A soft-removed member keeps their records.
    SET LOCAL ROLE authenticated;
    INSERT INTO public.signed_documents (buyer_account_id, account_member_id, document_type, document_version, signed_name)
    VALUES (acc, m2, 'HOLD_HARMLESS', 'verify', 'Verify Second');
    UPDATE public.account_members SET status = 'removed', removed_at = now() WHERE id = m2;
    RESET ROLE;
    SELECT count(*) INTO n FROM public.signed_documents WHERE account_member_id = m2;
    names := array_append(names, ('(7) removed member keeps row and signature')::text);
    results := array_append(results, (CASE WHEN n = 1 AND (SELECT status FROM public.account_members WHERE id = m2) = 'removed' THEN 'PASS' ELSE 'FAIL' END)::text);
    details := array_append(details, (('signatures kept: ' || n))::text);
    BEGIN
      DELETE FROM public.account_members WHERE id = m2;
      names := array_append(names, ('members are never hard-deleted')::text); results := array_append(results, ('FAIL')::text); details := array_append(details, ('delete succeeded')::text);
    EXCEPTION WHEN OTHERS THEN
      names := array_append(names, ('members are never hard-deleted')::text); results := array_append(results, ('PASS')::text); details := array_append(details, (SQLERRM)::text);
    END;

    -- (6) After the Golden Ticket, the buyer can't change members.
    SET LOCAL ROLE authenticated;
    INSERT INTO public.account_members (buyer_account_id, full_name, role, email)
    VALUES (acc, 'Verify Later', 'member', 'verify-later@example.invalid') RETURNING id INTO m2;
    RESET ROLE;
    UPDATE public.buyer_accounts SET golden_ticket_issued = true WHERE id = acc;
    BEGIN
      SET LOCAL ROLE authenticated;
      UPDATE public.account_members SET status = 'removed', removed_at = now() WHERE id = m2;
      RESET ROLE;
      names := array_append(names, ('(6) removal refused after the Golden Ticket')::text); results := array_append(results, ('FAIL')::text); details := array_append(details, ('update succeeded')::text);
    EXCEPTION WHEN OTHERS THEN
      names := array_append(names, ('(6) removal refused after the Golden Ticket')::text); results := array_append(results, (CASE WHEN SQLERRM ILIKE '%Golden Ticket%' THEN 'PASS' ELSE 'FAIL' END)::text); details := array_append(details, (SQLERRM)::text);
    END;

    RAISE EXCEPTION 'verify_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'verify_rollback' THEN
      names := array_append(names, ('unexpected error')::text); results := array_append(results, ('FAIL')::text); details := array_append(details, (SQLERRM)::text);
    END IF;
  END;

  RETURN QUERY SELECT names[i], results[i], details[i] FROM generate_subscripts(names, 1) AS i;
END;
$$;

SELECT * FROM pg_temp.verify_account_members();
