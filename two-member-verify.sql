-- Two-member accounts: a READ-ONLY check of the real database. Run in the Supabase SQL editor.
-- It changes nothing (only SELECTs). Every row says PASS, FAIL or INFO, with what it found.
-- Run two-member-fixes.sql first if the filing-roster line says FAIL.

CREATE OR REPLACE FUNCTION pg_temp.verify_two_member()
RETURNS TABLE (check_name text, result text, detail text) LANGUAGE plpgsql AS $$
DECLARE n bigint; msg text;
BEGIN
  -- 1. Members: at most two active, exactly one primary.
  SELECT count(*) INTO n FROM (SELECT buyer_account_id FROM public.account_members WHERE status = 'active' GROUP BY 1 HAVING count(*) > 2) x;
  check_name := '1. no account has more than two active members'; result := CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END; detail := n || ' account(s) over the limit'; RETURN NEXT;
  SELECT count(*) INTO n FROM (SELECT buyer_account_id FROM public.account_members WHERE status = 'active' GROUP BY 1 HAVING count(*) FILTER (WHERE role = 'primary') <> 1) x;
  check_name := '2. every account has exactly one active primary'; result := CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END; detail := n || ' account(s) without exactly one'; RETURN NEXT;
  SELECT count(*) INTO n FROM public.account_members WHERE status = 'active' AND (coalesce(btrim(full_name), '') = '' OR coalesce(btrim(email), '') = '');
  check_name := '3. every active member has a name and an email (notices go to each member)'; result := CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END; detail := n || ' active member(s) missing one'; RETURN NEXT;
  SELECT count(*) INTO n FROM public.account_members WHERE status = 'active';
  check_name := 'info: active members / accounts with two'; result := 'INFO';
  detail := n || ' active members; ' || (SELECT count(*) FROM (SELECT 1 FROM public.account_members WHERE status = 'active' GROUP BY buyer_account_id HAVING count(*) = 2) y) || ' two-member accounts'; RETURN NEXT;

  -- 4. Cap table: every active member's name is on the row of their account (the missing-name gap).
  SELECT count(*) INTO n FROM public.cap_table_entries c
    JOIN public.account_members m ON m.buyer_account_id = c.buyer_account_id AND m.status = 'active'
    WHERE c.buyer_account_id IS NOT NULL AND NOT (m.full_name = ANY (coalesce(c.account_member_names, ARRAY[]::text[])));
  check_name := '4. cap table rows name every active member of their account'; result := CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END; detail := n || ' member name(s) missing from a cap table row (resync the cap table if the lock is still open)'; RETURN NEXT;

  -- 5. Signatures name the member who signed.
  SELECT count(*) INTO n FROM public.signed_documents WHERE document_type IN ('PRA', 'HOLD_HARMLESS', 'block_5_independent_advice') AND buyer_account_id IS NOT NULL AND account_member_id IS NULL;
  check_name := '5. PRA, Hold Harmless and Block 5 signatures all name a member'; result := CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END; detail := n || ' signature(s) with no member (run member-steps.sql to backfill)'; RETURN NEXT;

  -- 6. One live Standard version.
  IF to_regclass('public.standard_versions') IS NULL THEN
    check_name := '6. exactly one Standard version is live'; result := 'FAIL'; detail := 'standard_versions is missing: run standard-versions.sql'; RETURN NEXT;
  ELSE
    EXECUTE 'SELECT count(*) FROM public.standard_versions WHERE is_live' INTO n;
    check_name := '6. exactly one Standard version is live'; result := CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END; detail := n || ' live version(s)'; RETURN NEXT;
  END IF;

  -- 7. One earnest-money and one closing-funds obligation per account per property.
  FOREACH msg IN ARRAY ARRAY['earnest_money_obligations', 'closing_funds_obligations'] LOOP
    IF to_regclass('public.' || msg) IS NULL THEN
      check_name := '7. one ' || msg || ' per account per property'; result := 'INFO'; detail := 'table not found'; RETURN NEXT;
    ELSE
      EXECUTE format('SELECT count(*) FROM (SELECT property_id, buyer_account_id FROM public.%I GROUP BY 1, 2 HAVING count(*) > 1) x', msg) INTO n;
      check_name := '7. one ' || msg || ' per account per property'; result := CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END; detail := n || ' duplicate(s)'; RETURN NEXT;
    END IF;
  END LOOP;

  -- 8. The filing record names every member (needs two-member-fixes.sql).
  IF to_regclass('public.entity_genesis') IS NULL THEN
    check_name := '8. the state filing record keeps its roster'; result := 'INFO'; detail := 'entity_genesis not found'; RETURN NEXT;
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'entity_genesis' AND column_name = 'filing_roster') THEN
    check_name := '8. the state filing record keeps its roster'; result := 'FAIL'; detail := 'column entity_genesis.filing_roster is missing: run two-member-fixes.sql'; RETURN NEXT;
  ELSE
    EXECUTE 'SELECT count(*) FROM public.entity_genesis WHERE atlas_request_status IN (''requested'', ''completed'') AND filing_roster IS NULL' INTO n;
    check_name := '8. the state filing record keeps its roster'; result := CASE WHEN n = 0 THEN 'PASS' ELSE 'INFO' END; detail := n || ' filing(s) requested before the roster was kept (the audit log still names the members)'; RETURN NEXT;
  END IF;

  -- 9. Every kind of member data is keyed by the member.
  FOREACH msg IN ARRAY ARRAY['eligibility_declarations', 'eligibility_results', 'member_liveness_checks', 'member_w9', 'member_plaid_consents', 'member_block2_authorizations', 'eligibility_page_acknowledgements'] LOOP
    IF to_regclass('public.' || msg) IS NULL THEN
      check_name := '9. ' || msg || ' is keyed by the member'; result := 'INFO'; detail := 'table not found (run its SQL file)'; RETURN NEXT;
    ELSE
      check_name := '9. ' || msg || ' is keyed by the member';
      result := CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = msg AND column_name = 'account_member_id') THEN 'PASS' ELSE 'FAIL' END;
      detail := 'has account_member_id'; RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

SELECT * FROM pg_temp.verify_two_member();
