-- divieight: fix contributions that were posted to the ledger twice.
--
-- What happened: capital-accounts.sql was run again after capital-events.sql, which put back an older version of
-- sync_owner_capital_from_ledger. From then on, every confirmed capital call or expense payment posted its own entry
-- ('contribution:<id>') AND a second, identical one ('owner_capital_accounts:<id>', memo 'Contribution recorded in
-- owner_capital_accounts'). The owner's capital account and owner_capital_accounts.contributed_amount were both too high
-- by the amount of each payment.
--
-- Run in the Supabase SQL editor. Safe to run again: an entry is only ever reversed once.
--   Step 1 installs the corrected function (the same one now in capital-accounts.sql and capital-events.sql).
--   Step 2 lists the duplicates it is about to reverse, so you can look first.
--   Step 3 reverses each duplicate with a reversing entry. Nothing is deleted; the history stays. The Month 5 total
--          (owner_capital_accounts) follows the ledger down on its own.

-- ---------------------------------------------------------------------------------------------------------
-- 1. The corrected function
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_owner_capital_from_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  holder uuid;
  t record;
  eff_c bigint := 0;
  eff_d bigint := 0;
  cur record;
  has_row boolean;
BEGIN
  IF NEW.line_type NOT IN ('contribution', 'distribution') THEN
    RETURN NULL;
  END IF;
  -- A contribution posted from its tagged record: Month 5 writes the table itself, once, right after.
  IF COALESCE(current_setting('app.skip_owner_sync', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  holder := NEW.member_key;
  IF EXISTS (SELECT 1 FROM public.buyer_accounts WHERE id = NEW.member_key) THEN
    SELECT auth_user_id INTO holder FROM public.buyer_accounts WHERE id = NEW.member_key;
  END IF;
  IF holder IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO t FROM public.capital_member_totals(NEW.property_id, NEW.member_key);
  IF NEW.line_type = 'contribution' THEN eff_c := NEW.amount_cents; ELSE eff_d := -NEW.amount_cents; END IF;
  SELECT round(contributed_amount * 100)::bigint AS c, round(distributions_amount * 100)::bigint AS d INTO cur
  FROM public.owner_capital_accounts WHERE property_id = NEW.property_id AND user_id = holder;
  has_row := FOUND;
  PERFORM set_config('app.ledger_sync', 'on', true);
  IF NOT has_row THEN
    INSERT INTO public.owner_capital_accounts (property_id, user_id, contributed_amount, distributions_amount, updated_at)
    VALUES (NEW.property_id, holder, t.contributed_cents / 100.0, t.distributions_cents / 100.0, now());
  ELSIF cur.c = t.contributed_cents - eff_c AND cur.d = t.distributions_cents - eff_d THEN
    UPDATE public.owner_capital_accounts SET contributed_amount = t.contributed_cents / 100.0, distributions_amount = t.distributions_cents / 100.0, updated_at = now()
    WHERE property_id = NEW.property_id AND user_id = holder;
  END IF;
  PERFORM set_config('app.ledger_sync', 'off', true);
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 2. The duplicates: a capture entry with the same property, member and amount as a tagged contribution posted
--    just before it (the same confirmation, so within a few seconds), not reversed yet.
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.double_posted_contributions WITH (security_invoker = true) AS
SELECT dup.id AS duplicate_entry_id, orig.id AS original_entry_id, dup.property_id, dl.member_id, dl.credit_cents AS cents, dup.posted_at
FROM public.journal_entries dup
JOIN public.journal_lines dl ON dl.entry_id = dup.id AND dl.member_id IS NOT NULL AND dl.credit_cents > 0
JOIN public.journal_entries orig ON orig.property_id = dup.property_id AND orig.source_ref LIKE 'contribution:%' AND orig.posted_at <= dup.posted_at AND dup.posted_at - orig.posted_at < interval '5 seconds'
JOIN public.journal_lines ol ON ol.entry_id = orig.id AND ol.member_id = dl.member_id AND ol.credit_cents = dl.credit_cents
WHERE dup.source_ref LIKE 'owner_capital_accounts:%'
  AND dup.memo = 'Contribution recorded in owner_capital_accounts'
  AND dup.reverses_entry_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.journal_entries r WHERE r.reverses_entry_id = dup.id);
REVOKE ALL ON public.double_posted_contributions FROM PUBLIC, anon, authenticated;

SELECT * FROM public.double_posted_contributions ORDER BY posted_at;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Reverse each one
-- ---------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  d record;
  n integer := 0;
BEGIN
  FOR d IN SELECT DISTINCT duplicate_entry_id FROM public.double_posted_contributions LOOP
    PERFORM public.reverse_entry(d.duplicate_entry_id, 'Posted twice by mistake: the same contribution is already in the ledger.', '{}'::jsonb);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'Reversed % double-posted contribution(s).', n;
END;
$$;

-- To check afterwards, run this on its own. Every row should say matches = true:
--   SELECT property_id, user_id, matches, table_contributed_cents, ledger_contributed_cents FROM public.owner_capital_reconciliation ORDER BY property_id;
