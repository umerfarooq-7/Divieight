/**
 * The Year-End CPA Export Packet's JSON, as a versioned JSON Schema (draft-07). schemas/year-end-packet.schema.json is this object written to a
 * file (a test keeps the two identical), so a CPA or tax software can validate a packet without this code.
 *
 * Money is whole US cents, as integers (debit_cents, credit_cents...). Dates are YYYY-MM-DD. A packet's general file never has a TIN in it; the
 * private "with TINs" file adds `tin` to each member and nothing else.
 */
export const PACKET_SCHEMA_VERSION = "1.1.0";

const cents = { type: "integer" };
const date = { type: "string", format: "date" };
const uuid = { type: "string", format: "uuid" };
const nullableUuid = { type: ["string", "null"], format: "uuid" };

export const PACKET_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://divieight.vercel.app/schemas/year-end-packet.schema.json",
  title: "divieight Year-End CPA Export Packet",
  description: "One LLC, one calendar year: the books as the CPA needs them. Not a tax return: no K-1, no Form 1065, no depreciation and no Section 754 figure is ever in it.",
  type: "object",
  required: ["schema_version", "packet_id", "property", "period", "accounts", "entries", "members", "roll_forwards", "worksheet"],
  properties: {
    schema_version: { type: "string", const: PACKET_SCHEMA_VERSION },
    packet_id: uuid,
    version: { type: "integer", minimum: 1 },
    generated_at: { type: "string", format: "date-time" },
    trigger: { type: "string", enum: ["scheduled", "manual"] },
    property: {
      type: "object",
      required: ["property_id", "llc_name", "address"],
      properties: {
        property_id: uuid,
        llc_name: { type: ["string", "null"] },
        address: { type: ["string", "null"] },
        city: { type: ["string", "null"] },
        state: { type: ["string", "null"] },
        zip: { type: ["string", "null"] },
        total_shares: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    period: {
      type: "object",
      required: ["year", "start", "end"],
      properties: { year: { type: "integer", minimum: 2000, maximum: 2200 }, start: date, end: date },
      additionalProperties: false,
    },
    accounts: {
      type: "array",
      items: {
        type: "object",
        required: ["code", "name", "type", "normal_balance"],
        properties: {
          code: { type: "string", pattern: "^[0-9]{4}$" },
          name: { type: "string", minLength: 1 },
          type: { type: "string", enum: ["asset", "liability", "equity", "income", "expense"] },
          normal_balance: { type: "string", enum: ["debit", "credit"] },
          member_control: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    entries: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "date", "source", "memo", "lines"],
        properties: {
          id: uuid,
          date,
          source: { type: "string" },
          source_ref: { type: ["string", "null"] },
          memo: { type: "string" },
          reverses_entry_id: nullableUuid,
          adjustment: { type: "boolean" },
          bank: { type: ["object", "null"], properties: { merchant: { type: ["string", "null"] }, raw_category: { type: ["string", "null"] } }, additionalProperties: false },
          lines: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              required: ["account_code", "account_name", "category", "debit_cents", "credit_cents"],
              properties: {
                account_code: { type: "string", pattern: "^[0-9]{4}$" },
                account_name: { type: "string" },
                category: { type: "string", enum: ["asset", "liability", "equity", "income", "expense"] },
                member_key: nullableUuid,
                debit_cents: { type: "integer", minimum: 0 },
                credit_cents: { type: "integer", minimum: 0 },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    trial_balance: {
      type: "object",
      required: ["as_of", "rows", "total_debit_cents", "total_credit_cents", "balanced"],
      properties: {
        as_of: date,
        rows: {
          type: "array",
          items: {
            type: "object",
            required: ["code", "name", "type", "debit_cents", "credit_cents", "balance_cents"],
            properties: { code: { type: "string" }, name: { type: "string" }, type: { type: "string" }, debit_cents: cents, credit_cents: cents, balance_cents: cents },
            additionalProperties: false,
          },
        },
        total_debit_cents: cents,
        total_credit_cents: cents,
        balanced: { type: "boolean" },
      },
      additionalProperties: false,
    },
    balance_sheet: {
      type: "object",
      required: ["as_of", "assets", "member_capital", "total_assets_cents", "total_liabilities_and_equity_cents", "balanced"],
      properties: {
        as_of: date,
        assets: { type: "array", items: { type: "object", required: ["code", "name", "balance_cents"], properties: { code: { type: "string" }, name: { type: "string" }, balance_cents: cents } } },
        liabilities: { type: "array", items: { type: "object", required: ["code", "name", "balance_cents"], properties: { code: { type: "string" }, name: { type: "string" }, balance_cents: cents } } },
        member_capital: { type: "array", items: { type: "object", required: ["member_key", "balance_cents"], properties: { member_key: uuid, balance_cents: cents } } },
        unallocated_net_income_cents: cents,
        total_assets_cents: cents,
        total_liabilities_and_equity_cents: cents,
        balanced: { type: "boolean" },
      },
      additionalProperties: false,
    },
    income_statement: {
      type: "object",
      required: ["year", "income_cents", "expense_cents", "net_cents", "income", "expense"],
      properties: {
        year: { type: "integer" },
        income_cents: cents,
        expense_cents: cents,
        net_cents: cents,
        income: { $ref: "#/definitions/statement_accounts" },
        expense: { $ref: "#/definitions/statement_accounts" },
        allocated_to_members: { type: "object", properties: { income_allocated_cents: cents, expense_allocated_cents: cents }, additionalProperties: false },
      },
      additionalProperties: false,
    },
    members: {
      type: "array",
      items: {
        type: "object",
        required: ["member_key", "legal_name", "share_count", "tin_status"],
        properties: {
          member_key: uuid,
          legal_name: { type: "string", minLength: 1 },
          // 0 for someone who held a share during the year and no longer does (their capital account is still in the packet).
          share_count: { type: "integer", minimum: 0 },
          interest_percent: { type: "string", pattern: "^[0-9]{1,3}\\.[0-9]{2}$" },
          mailing_address: { type: ["string", "null"] },
          tin_kind: { type: ["string", "null"], enum: ["ssn", "ein", null] },
          tin_status: { type: "string", enum: ["on_file", "missing"] },
          // Only in the private file with TINs.
          tin: { type: "string", pattern: "^([0-9]{3}-[0-9]{2}-[0-9]{4}|[0-9]{2}-[0-9]{7})$" },
        },
        additionalProperties: false,
      },
    },
    roll_forwards: {
      type: "array",
      items: {
        type: "object",
        required: ["member_key", "beginning_cents", "contributions_cents", "distributions_cents", "income_cents", "expense_cents", "depreciation_cents", "ending_cents"],
        properties: {
          member_key: uuid,
          beginning_cents: cents,
          contributions_cents: cents,
          distributions_cents: cents,
          income_cents: cents,
          expense_cents: cents,
          depreciation_cents: cents,
          transfers_cents: cents,
          ending_cents: cents,
          prior_year_ending_cents: cents,
          beginning_matches_prior_ending: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
    forms_1099: {
      type: "array",
      items: { type: "object", required: ["vendor_name", "form_type", "tax_year", "amount_cents"], properties: { vendor_name: { type: "string" }, form_type: { type: "string" }, tax_year: { type: "integer" }, amount_cents: cents, issued_at: { type: ["string", "null"] }, file: { type: ["string", "null"] } }, additionalProperties: false },
    },
    worksheet: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["item_type", "title", "status"],
            properties: {
              item_type: { type: "string", enum: ["depreciation_needed", "section_754_review", "lodging_tax_exposure", "other"] },
              title: { type: "string" },
              status: { type: "string", enum: ["open", "reviewed"] },
              manager_note: { type: ["string", "null"] },
              detail: { type: "object" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    // The Tax-Ready Folder's data for the year (1.1.0): per-share ownership, the 1099-S sale data and the reconciliation. No TIN.
    tax_ready: {
      type: "object",
      required: ["year", "shares", "members", "transfers", "sales_1099s", "reconciliation"],
      properties: {
        year: { type: "integer" },
        shares: {
          type: "array",
          items: {
            type: "object",
            required: ["share_number", "days_accounted_for", "periods"],
            properties: {
              share_number: { type: "integer", minimum: 1 },
              year_end_holder_key: nullableUuid,
              days_accounted_for: { type: "integer", minimum: 0 },
              periods: { type: "array", items: { type: "object", required: ["holder_key", "from", "to", "days"], properties: { holder_key: nullableUuid, from: date, to: date, days: { type: "integer", minimum: 0 } }, additionalProperties: false } },
            },
            additionalProperties: false,
          },
        },
        members: {
          type: "array",
          items: {
            type: "object",
            required: ["member_key", "year_end_shares", "share_days", "percent_of_share_days", "legal_names"],
            properties: { member_key: uuid, year_end_shares: { type: "integer", minimum: 0 }, share_days: { type: "integer", minimum: 0 }, percent_of_share_days: { type: "string", pattern: "^[0-9]{1,3}\\.[0-9]{4}$" }, legal_names: { type: "array", items: { type: "string" } } },
            additionalProperties: false,
          },
        },
        transfers: {
          type: "array",
          items: { type: "object", required: ["share_number", "date", "transferor_member_key", "transferee_member_key"], properties: { share_number: { type: "integer" }, date, transferor_member_key: nullableUuid, transferee_member_key: nullableUuid, resale_transaction_id: nullableUuid }, additionalProperties: false },
        },
        sales_1099s: {
          type: "array",
          items: {
            type: "object",
            required: ["resale_transaction_id", "date", "share_number", "gross_proceeds_cents", "transferor_names", "transferee_names"],
            properties: {
              resale_transaction_id: uuid,
              date,
              share_number: { type: "integer" },
              transferor_member_key: nullableUuid,
              transferee_member_key: nullableUuid,
              gross_proceeds_cents: cents,
              property_address: { type: ["string", "null"] },
              transferor_names: { type: "array", items: { type: "string" } },
              transferee_names: { type: "array", items: { type: "string" } },
              transferor_tin_status: { type: "string", enum: ["on_file", "missing"] },
            },
            additionalProperties: false,
          },
        },
        reconciliation: {
          type: "object",
          required: ["total_shares", "year_end_shares", "days_in_year", "share_days_total", "share_days_expected", "reconciled"],
          properties: { total_shares: { type: "integer" }, year_end_shares: { type: "integer" }, days_in_year: { type: "integer" }, share_days_total: { type: "integer" }, share_days_expected: { type: "integer" }, reconciled: { type: "boolean" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    totals: {
      type: "object",
      properties: { entries: { type: "integer" }, debit_cents: cents, credit_cents: cents },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
  definitions: {
    statement_accounts: {
      type: "array",
      items: {
        type: "object",
        required: ["code", "name", "total_cents", "items"],
        properties: {
          code: { type: "string" },
          name: { type: "string" },
          total_cents: cents,
          items: { type: "array", items: { type: "object", required: ["date", "memo", "amount_cents"], properties: { date, memo: { type: "string" }, amount_cents: cents }, additionalProperties: false } },
        },
        additionalProperties: false,
      },
    },
  },
} as const;
