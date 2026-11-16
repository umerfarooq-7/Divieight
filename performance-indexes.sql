-- Performance indexes. Run once in the Supabase SQL editor, AFTER every other script (it only indexes tables that already exist). Safe to run again, and safe on a database that does not have every table yet: each index is created only if
-- its table and columns exist. Nothing here changes data or behaviour; it only makes the busiest lookups cheaper. See docs/performance.md for the query plans.
--
-- What each one serves:
--   journal_entries (property_id, entry_date DESC, posted_at DESC)   statements, trial balance and ledger pages: one property, newest first
--   journal_lines (entry_id, account_id)                              the lines of an entry together with the account, without visiting the table
--   journal_lines (account_id, entry_id)                              an account's activity (balances by account)
--   bank_transactions (property_id, posted_date DESC)                 the feed page, newest first
--   bank_transactions (property_id, status) WHERE status needs action the review queue
--   audit_log (entity_type, entity_id, created_at DESC)               the history of one record
--   audit_log (action_type, created_at DESC)                          alert rules, admin filters, reminders count
--   cap_table_entries (property_id, share_number)                     the cap table of one property
--   notifications (seller_id, created_at DESC)                        the bell: a person's latest
--   notifications (seller_id) WHERE unread                            the unread badge

CREATE OR REPLACE FUNCTION pg_temp.ensure_index(idx text, tbl text, cols text[], definition text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c text;
BEGIN
  IF to_regclass('public.' || tbl) IS NULL THEN RETURN; END IF;
  FOREACH c IN ARRAY cols LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = tbl AND column_name = c) THEN RETURN; END IF;
  END LOOP;
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I %s', idx, tbl, definition);
END;
$$;

SELECT pg_temp.ensure_index('journal_entries_property_date_idx', 'journal_entries', ARRAY['property_id', 'entry_date', 'posted_at'], '(property_id, entry_date DESC, posted_at DESC)');
SELECT pg_temp.ensure_index('journal_lines_entry_account_idx', 'journal_lines', ARRAY['entry_id', 'account_id'], '(entry_id, account_id) INCLUDE (debit_cents, credit_cents)');
SELECT pg_temp.ensure_index('journal_lines_account_entry_idx', 'journal_lines', ARRAY['account_id', 'entry_id'], '(account_id, entry_id)');
SELECT pg_temp.ensure_index('bank_transactions_property_posted_idx', 'bank_transactions', ARRAY['property_id', 'posted_date'], '(property_id, posted_date DESC)');
SELECT pg_temp.ensure_index('bank_transactions_needs_action_idx', 'bank_transactions', ARRAY['property_id', 'status'], '(property_id, posted_date DESC) WHERE status IN (''new'', ''needs_review'')');
SELECT pg_temp.ensure_index('audit_log_entity_time_idx', 'audit_log', ARRAY['entity_type', 'entity_id', 'created_at'], '(entity_type, entity_id, created_at DESC)');
SELECT pg_temp.ensure_index('audit_log_action_time_idx', 'audit_log', ARRAY['action_type', 'created_at'], '(action_type, created_at DESC)');
SELECT pg_temp.ensure_index('cap_table_entries_property_share_idx', 'cap_table_entries', ARRAY['property_id', 'share_number'], '(property_id, share_number)');
SELECT pg_temp.ensure_index('notifications_recipient_time_idx', 'notifications', ARRAY['seller_id', 'created_at'], '(seller_id, created_at DESC)');
SELECT pg_temp.ensure_index('notifications_unread_idx', 'notifications', ARRAY['seller_id', 'is_read'], '(seller_id) WHERE is_read = false');
