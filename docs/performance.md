# Performance: indexes, query plans, pagination

## Indexes

`performance-indexes.sql` adds (only where the table and columns exist; safe to re-run; run after every other script):

| Index | Serves |
|---|---|
| `journal_entries (property_id, entry_date DESC, posted_at DESC)` | ledger, trial balance and statements for one property, newest first |
| `journal_lines (entry_id, account_id) INCLUDE (debit, credit)` | the lines of an entry, without visiting the table |
| `journal_lines (account_id, entry_id)` | an account's activity |
| `bank_transactions (property_id, posted_date DESC)` and a partial one for `new`/`needs_review` | the bank feed and the review queue |
| `audit_log (entity_type, entity_id, created_at DESC)` and `(action_type, created_at DESC)` | the history of one record; alert rules and counts |
| `cap_table_entries (property_id, share_number)` | one property's cap table |
| `notifications (seller_id, created_at DESC)` and a partial one for unread | the bell and the unread badge |

Note: `journal_lines` has no property or date column of its own; the property-and-date lookup goes through `journal_entries`, which is why that table carries the property-and-date index.

## EXPLAIN

`tests/hardening-db.test.ts` runs EXPLAIN for ten of the busiest queries on the database built from the repository's SQL (with sequential scans disabled, on empty tables) and requires each to be answered by an
index; the plans are written to [performance-explain.md](performance-explain.md). **Honest limit:** this proves the access path, not timings. The prompt asked for the 20 slowest queries; those can only be found on production with real data
(`pg_stat_statements`, Supabase Dashboard > Query Performance). Do that after the first weeks of real use and add what it shows.

## Pagination

- The bell reads 10 notifications; dashboards and lists mostly filter by property or person.
- **GAP: no list is paginated in a deliberate, uniform way.** Supabase caps any response at **1,000 rows** (`max_rows`), and many reads select without `.limit()` or `.range()`. For small sets (a property's 8 cap-table rows) that is harmless. For growing ones it means silent truncation past 1,000 rows:
  the ledger and books readers (`books.server.ts`, `cpa.server.ts`, `inquiries.server.ts`: journal lines and bank transactions), the Audit Vault viewer, and notification history. A scan found about 135 unbounded reads of the larger tables.
  Fixing it changes screens (page controls) and, for balances, means computing sums in the database (a SQL function) instead of adding up rows in the server; that was out of scope for a pass that must not change features. **Do this before a property's ledger can exceed 1,000 lines**, which at a few entries per day takes about a year; the first things to convert are the ledger list, the bank feed list and the audit log viewer (keyset pagination on `(entry_date, posted_at, id)` and `(created_at, id)`).
