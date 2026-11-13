# Year-End CPA Export Packet: sample packets

Two sample packets (`sample-packet-1.json`, `sample-packet-2.json`) for one LLC and one calendar year (2025), made from real ledger output by
`tests/year-end-packet-sql.test.ts` and checked against `schemas/year-end-packet.schema.json` (JSON Schema draft-07, `schema_version` 1.0.0).
The names, addresses and amounts are test data. Ids are replaced with sequential ones so the files are identical every time they are made.

- Money is whole US cents, as integers (`debit_cents`, `credit_cents`, `balance_cents`...). Dates are `YYYY-MM-DD`.
- `members` carries legal name, share count, mailing address and whether a TIN is on file. The general file never has a TIN. The private
  "with TINs" file the Manager downloads adds `tin` to each member and nothing else.
- Sample 2 also has a depreciation entry from the CPA's schedule, a Section 754 flag (flag only, no figure), a 1099 copy and a bank merchant.
- There is no K-1, Form 1065, depreciation or Section 754 figure in a packet, by design.

ASSUMPTION: the JSON has been validated only against this schema. A CPA must validate it against real Lacerte or ProConnect before launch.
Send these two files to one.

To make them again after a schema change: `UPDATE_SAMPLES=1 npx vitest run tests/year-end-packet-sql.test.ts`.
