/**
 * The Audit Vault completeness inventory: every state-changing event in the app, whether it writes to the Audit Vault, and where.
 *
 * Each event is covered in one or both of two ways:
 *   - the application writes an audit row (`actions`, found in `files`), and/or
 *   - the database writes one whatever code made the change (`tables`: the row-level safety net in audit-vault.sql).
 *
 * tests/audit-vault.test.ts fails when a listed action is no longer written by its file, when a listed table loses its trigger, and when an event has
 * neither. Add a row here when you add an action that changes state.
 */

export type InventoryStatus =
  /** Wrote to the Audit Vault before the Audit Vault hardening. */
  | "covered"
  /** There was a gap: closed by an application audit row added in the hardening. */
  | "fixed_app"
  /** There was a gap: closed by the database safety net (every change to the table is recorded, whatever code made it). */
  | "fixed_db"
  /** New in the hardening. */
  | "new";

export interface InventoryEvent {
  area: string;
  event: string;
  /** A critical action: it must always leave a row. */
  critical: boolean;
  status: InventoryStatus;
  /** Audit action types the application writes for it. */
  actions?: string[];
  /** The source files (or SQL files) that write them. */
  files?: string[];
  /** Tables whose every change the database records. */
  tables?: string[];
  /** For an action name the code builds from parts: text that must appear in a file (the pattern itself). */
  dynamic?: string[];
  note?: string;
}

const E = (area: string, event: string, status: InventoryStatus, o: Omit<InventoryEvent, "area" | "event" | "status" | "critical"> & { critical?: boolean }): InventoryEvent => ({ area, event, status, critical: o.critical ?? true, ...o });

export const AUDIT_INVENTORY: InventoryEvent[] = [
  // ---- Registration and onboarding ----------------------------------------------------------------
  E("Registration", "Buyer registers", "covered", { actions: ["buyer.registered"], files: ["src/routes/buyer.register.tsx"], tables: ["buyer_accounts", "account_members"] }),
  E("Registration", "Seller registers", "covered", { actions: ["seller.registered"], files: ["src/routes/register.tsx"], tables: ["sellers"] }),
  E("Registration", "Agent registers", "fixed_db", { tables: ["agents"], note: "The registration screen wrote straight to the table with no audit row." }),
  E("Registration", "Broker of Record registers", "fixed_db", { tables: ["brokers"], note: "The registration screen wrote straight to the table with no audit row." }),
  E("Onboarding", "Eligibility Standard read", "covered", { actions: ["buyer.eligibility_standard_read"], files: ["src/lib/eligibility-standard.server.ts"] }),
  E("Onboarding", "Identity submitted", "covered", { actions: ["buyer.identity_submitted"], files: ["src/lib/account-members.server.ts"] }),
  E("Onboarding", "Liveness check", "covered", { actions: ["buyer.liveness_checked"], files: ["src/lib/liveness.server.ts"] }),
  E("Onboarding", "Plaid consent (Block 1)", "covered", { actions: ["buyer.plaid_consent_given"], files: ["src/lib/member-steps.server.ts"] }),
  E("Onboarding", "LPOA acceptance (Block 2)", "covered", { actions: ["buyer.block2_lpoa_accepted"], files: ["src/lib/member-steps.server.ts"] }),
  E("Onboarding", "W-9 submitted", "covered", { actions: ["buyer.w9_submitted"], files: ["src/lib/w9.server.ts"] }),
  E("Onboarding", "Golden Ticket issued", "covered", { actions: ["buyer.golden_ticket_issued"], files: ["src/lib/golden-ticket.ts"], tables: ["buyer_accounts"] }),
  // ---- Declarations and results -------------------------------------------------------------------
  E("Declarations", "Eligibility declaration made", "covered", { actions: ["buyer.eligibility_declaration_made"], files: ["src/lib/eligibility-declaration.server.ts"], tables: ["eligibility_declarations"], note: "The answers are never in the log." }),
  E("Declarations", "Eligibility result determined", "covered", { actions: ["eligibility.recomputed"], files: ["src/lib/eligibility-engine.server.ts"], tables: ["eligibility_results"] }),
  E("Declarations", "Sanctions screening", "covered", { actions: ["eligibility.sanctions_screened"], files: ["src/lib/eligibility-engine.server.ts"] }),
  // ---- Payments -----------------------------------------------------------------------------------
  E("Payments", "Buyer enrollment fee paid", "fixed_app", { actions: ["payment.enrollment_fee_confirmed"], files: ["src/utils/payments.functions.ts"], tables: ["buyer_enrollment_payments"], note: "Only the browser logged this: a closed tab left no record. The server now records it when Stripe confirms." }),
  E("Payments", "Seller enrollment fee paid", "fixed_app", { actions: ["payment.enrollment_fee_confirmed"], files: ["src/utils/payments.functions.ts"], tables: ["enrollment_payments"] }),
  // ---- Reservations, tethering, the hard lock -----------------------------------------------------
  E("Reservations", "Share reserved", "covered", { actions: ["buyer.share_reserved"], files: ["src/lib/reservations.functions.ts"], tables: ["pod_reservations"] }),
  E("Reservations", "Reservation withdrawn", "covered", { actions: ["buyer.reservation_withdrawn"], files: ["src/lib/reservations.functions.ts"], tables: ["pod_reservations"] }),
  E("Tethering", "Resident Agent tethered", "covered", { actions: ["buyer.resident_agent_tethered"], files: ["src/lib/tethering.functions.ts"], tables: ["buyer_accounts"] }),
  E("Tethering", "Agent designated", "covered", { actions: ["buyer.agent_designated"], files: ["src/lib/designation.functions.ts"] }),
  E("Tethering", "Per-property agent assigned", "covered", { actions: ["buyer.property_agent_assigned"], files: ["src/lib/property-agent.server.ts"], tables: ["property_agent_overrides"] }),
  E("Hard lock", "Pod hard-locked", "fixed_app", { actions: ["pod.hard_locked"], files: ["src/lib/reservations.functions.ts"], tables: ["properties"], note: "Only the Entity Genesis step that followed was logged, not the lock itself." }),
  E("Hard lock", "Pod system-locked (all shares reserved)", "fixed_app", { actions: ["pod.system_locked"], files: ["src/lib/reservations.functions.ts"], tables: ["properties"] }),
  // ---- Authorizations, earnest money, closing funds -----------------------------------------------
  E("Authorizations", "Authorization requested", "covered", { actions: ["authorization.requested"], files: ["src/lib/authorization.functions.ts"], tables: ["authorization_requests"] }),
  E("Authorizations", "Member confirms or declines", "covered", { actions: ["authorization.member_confirmed", "authorization.member_declined"], files: ["src/lib/authorization.functions.ts"], tables: ["authorization_responses"] }),
  E("Authorizations", "Authorization granted", "covered", { actions: ["authorization.granted"], files: ["src/lib/authorization.functions.ts"] }),
  E("Authorizations", "Commission provision proposed and authorized", "covered", { actions: ["authorization.commission_proposed", "authorization.commission_authorized"], files: ["src/lib/authorization.functions.ts"] }),
  E("Earnest money", "Obligation issued, funded, late, defaulted", "covered", { actions: ["earnest.obligation_issued", "earnest.funded", "earnest.late", "earnest.default_declared"], files: ["src/lib/funding-obligations.server.ts", "src/lib/audit.ts"], tables: ["earnest_money_obligations"] }),
  E("Closing funds", "Obligation issued, funded, late, defaulted", "covered", { actions: ["closing_funds.obligation_issued", "closing_funds.funded", "closing_funds.late", "closing_funds.default_declared"], files: ["src/lib/funding-obligations.server.ts"], tables: ["closing_funds_obligations"] }),
  // ---- Entity genesis, signatures, saga, disbursement ---------------------------------------------
  E("Entity genesis", "Digital Genesis created", "covered", { actions: ["entity.digital_genesis_created"], files: ["src/lib/entity-genesis.server.ts"], tables: ["entity_genesis"] }),
  E("Entity genesis", "Stage 2: Atlas, state filing, EIN, final OA, closing-ready", "covered", { actions: ["entity.state_filed", "entity.ein_issued", "entity.final_oa_generated", "entity.closing_ready", "entity.oa_executed"], files: ["src/lib/entity-genesis-stage2.server.ts"], tables: ["entity_genesis"] }),
  E("Signatures", "Operating Agreement signed", "covered", { actions: ["entity.oa_signed"], files: ["src/lib/entity-genesis-stage2.server.ts"], tables: ["operating_agreement_signatures"] }),
  E("Signatures", "PRA and Hold Harmless signed", "covered", { actions: ["buyer.pra_signed", "buyer.hold_harmless_signed"], files: ["src/lib/member-steps.server.ts"], tables: ["signed_documents"] }),
  E("Signatures", "Listing Agreement signed", "covered", { actions: ["seller.listing_agreement_signed"], files: ["src/routes/onboarding.agreement.tsx"], tables: ["signed_documents"] }),
  E("Signatures", "NAR Referral Agreement signed", "covered", { actions: ["agent.nar_referral_signed"], files: ["src/lib/nar-referral.functions.ts"], tables: ["signed_documents"] }),
  E("Signatures", "Signing for another member under authority", "covered", { actions: ["authority.granted", "authority.used", "authority.revoked"], files: ["src/lib/member-authority.server.ts"], tables: ["member_authority_grants"] }),
  E("Closing saga", "Saga steps, retries, completion, dead letter", "covered", { actions: ["closing_saga.step_succeeded", "closing_saga.step_failed", "closing_saga.saga_completed", "closing_saga.saga_dead_lettered"], files: ["src/lib/closing-saga.server.ts", "src/lib/saga/orchestrator.server.ts"], tables: ["saga_runs"] }),
  E("Disbursement", "Disbursement check passed or failed", "covered", { actions: ["disbursement_check.passed", "disbursement_check.failed"], files: ["src/lib/disbursement-check.server.ts"], tables: ["disbursement_checks"] }),
  E("Disbursement", "Source of Truth generated and transmitted", "covered", { actions: ["settlement.source_of_truth_generated", "settlement.cda_transmitted"], files: ["src/lib/settlement.server.ts"], tables: ["settlement_documents"] }),
  // ---- Cap table, commission ----------------------------------------------------------------------
  E("Cap table", "Cap table updated, locked, unlocked", "covered", { actions: ["entity.cap_table_updated", "entity.cap_table_locked"], files: ["src/lib/entity-genesis.server.ts", "src/lib/entity-genesis-stage2.server.ts"], tables: ["cap_table_entries"], note: "Protected: a change made directly in the database raises a Suspicious Activity Alert." }),
  E("Commission", "Commission splits and referral shares recorded at closing", "covered", { actions: ["closing_saga.step_succeeded", "settlement.source_of_truth_generated"], files: ["src/lib/closing-saga.server.ts", "src/lib/saga/orchestrator.server.ts", "src/lib/settlement.server.ts"], tables: ["commission_ledger", "settlement_documents", "buyer_attribution", "pending_referral_agreements"], note: "Protected." }),
  // ---- Votes, resale ------------------------------------------------------------------------------
  E("Votes", "Vote created, ballot cast, vote closed", "covered", { actions: ["vote.created", "vote.ballot_cast", "vote.closed"], files: ["src/lib/votes.server.ts"], tables: ["votes", "vote_ballots"] }),
  E("Resale", "Listing created, ROFR, offer, sale completed", "covered", { actions: ["resale.listing_created", "resale.rofr_exercised", "resale.sale_completed"], files: ["src/lib/resale.server.ts"], tables: ["resale_listings", "resale_transactions"] }),
  // ---- Money --------------------------------------------------------------------------------------
  E("Expenses", "Expense created and paid", "covered", { actions: ["expense.created", "expense.marked_paid"], files: ["src/lib/expenses.server.ts"], tables: ["expenses"] }),
  E("Capital calls", "Capital call created and paid", "covered", { actions: ["capital_call.created", "capital_call.marked_paid"], files: ["src/lib/expenses.server.ts"], tables: ["capital_calls"] }),
  E("Distributions", "Distribution created and posted", "covered", { actions: ["distribution.created", "distribution.reserve_set"], files: ["distributions.sql"], tables: ["distribution_events"] }),
  E("Journal", "Journal entry posted, reversed, period closed", "covered", { actions: ["ledger.entry_posted", "ledger.entry_reversed", "ledger.period_closed"], files: ["bookkeeping.sql"], tables: ["journal_entries"] }),
  E("Statements", "Monthly statement drafted and issued", "covered", { actions: ["statement.drafted", "statement.issued"], files: ["monthly-statements.sql"], tables: ["monthly_statements"] }),
  // ---- CPA, exports, TINs -------------------------------------------------------------------------
  E("CPA", "CPA designated, activated, rescinded", "covered", { actions: ["cpa.designated", "cpa.activated", "cpa.rescinded"], files: ["cpa-credential.sql"], tables: ["cpa_designations"] }),
  E("Exports", "Year-end packet and CPA downloads", "covered", { actions: ["packet.downloaded", "packet.pii_file_downloaded", "cpa.packet_downloaded"], files: ["year-end-packet.sql", "src/lib/cpa.server.ts"] }),
  E("Exports", "1099-NEC and Tax-Ready Folder downloads", "covered", { actions: ["influencer.1099_export", "tax_ready.file_downloaded"], files: ["src/lib/tax-forms.server.ts"] }),
  E("Exports", "Executed document downloaded", "covered", { actions: ["document.executed_copy_downloaded"], files: ["src/lib/document-access.functions.ts"], critical: false }),
  E("Exports", "Analytics and admin report exports", "new", { actions: ["analytics.report_exported"], files: ["src/lib/analytics.server.ts"] }),
  E("TIN decrypts", "A TIN is decrypted or shown", "covered", { actions: ["admin.w9_tin_decrypted", "cpa.w9_tin_viewed"], files: ["src/lib/w9.server.ts"], dynamic: ["tax_vault.${params.kind}_tin_viewed"], note: "The audit row is written first; if it cannot be written nothing is decrypted. Outside this path: a Suspicious Activity Alert." }),
  E("Tax", "Tax vault access granted or revoked", "covered", { actions: ["tax_vault.access_granted", "tax_vault.access_revoked"], files: ["tax-forms.sql"], tables: ["tax_vault_grants"] }),
  // ---- Admin overrides and configuration ----------------------------------------------------------
  E("Admin overrides", "Admin changes or removes a member", "covered", { actions: ["admin.member_updated", "admin.member_removed"], files: ["src/lib/account-members.server.ts"], tables: ["account_members"] }),
  E("Admin overrides", "Retention exception decided", "covered", { actions: ["retention_exception.approved", "retention_exception.rejected"], files: ["src/lib/retention.server.ts"], tables: ["retention_exceptions"] }),
  E("Admin overrides", "Held account snoozed", "covered", { actions: ["held.snoozed"], files: ["src/lib/held-reminders.server.ts"] }),
  E("Admin overrides", "Saga manually resumed", "covered", { actions: ["closing_saga.manual_resume_requested"], files: ["src/lib/closing-saga.functions.ts"] }),
  E("Admin overrides", "Admin role granted or removed", "fixed_db", { tables: ["user_roles"], note: "Granting a role was done straight in the database or a screen with no audit row." }),
  E("Configuration", "Governance settings and rules changed", "covered", { actions: ["governance.setting_changed"], files: ["src/lib/governance-config.server.ts"] }),
  E("Configuration", "Launch readiness updated", "covered", { actions: ["launch_readiness.updated"], files: ["src/lib/launch-readiness.server.ts"] }),
  E("Configuration", "Standard version published", "covered", { actions: ["standard.version_published"], files: ["src/lib/standard-version.server.ts"] }),
  E("Configuration", "Terms and Conditions published", "covered", { actions: ["tc.version_published", "tc.implicit_acceptance"], files: ["src/lib/tc.server.ts"] }),
  E("Configuration", "Platform settings changed", "fixed_db", { tables: ["platform_settings"], note: "No audit row was written when a setting changed." }),
  // ---- Know Your Owner retention ------------------------------------------------------------------
  E("KYO retention", "Account archived", "new", { actions: ["retention.account_archived"], files: ["src/lib/kyo-retention.server.ts"] }),
  E("KYO retention", "Nightly retention run and review opened", "new", { actions: ["retention.sweep_run", "retention.review_opened"], files: ["src/lib/kyo-retention.server.ts"] }),
  E("KYO retention", "Record erased (personal data anonymized)", "new", { actions: ["retention.erased"], files: ["kyo-retention.sql"], note: "Logged with counts and dates, never the erased data." }),
  E("KYO retention", "Erasure blocked by a legal hold or by the retention period", "new", { actions: ["retention.erasure_blocked_legal_hold", "retention.erasure_blocked_inside_retention"], files: ["src/lib/kyo-retention.server.ts", "kyo-retention.sql"] }),
  E("KYO retention", "Review kept, legal hold placed or lifted, LLC dissolution recorded", "new", { actions: ["retention.review_kept", "retention.legal_hold_placed", "retention.legal_hold_released", "retention.llc_dissolution_recorded"], files: ["src/lib/kyo-retention.server.ts"] }),
  E("KYO retention", "Member asks for deletion; request declined", "new", { actions: ["kyo.deletion_requested", "kyo.deletion_declined"], files: ["src/lib/kyo-retention.server.ts"], note: "A request inside the retention period is declined with the reason recorded." }),
  // ---- The Audit Vault itself ---------------------------------------------------------------------
  E("Audit Vault", "The Audit Vault is read", "new", { actions: ["audit.vault_accessed"], files: ["src/lib/audit-vault.server.ts", "audit-vault.sql"] }),
  E("Audit Vault", "Chain verification and Suspicious Activity Alerts", "new", { actions: ["audit.chain_verified", "security.suspicious_activity"], files: ["src/lib/audit-vault.server.ts"] }),
];

/** The tables that carry the database safety net, in audit-vault.sql. Protected ones raise a Suspicious Activity Alert on a direct change. */
export const PROTECTED_TABLES: Record<string, { allowedPrefixes: string[]; why: string }> = {
  cap_table_entries: { allowedPrefixes: ["entity.", "closing_saga.", "resale.", "substitution."], why: "ownership percentages and the cap table" },
  commission_ledger: { allowedPrefixes: ["closing_saga.", "settlement."], why: "commission splits" },
  settlement_documents: { allowedPrefixes: ["settlement.", "closing_saga.", "disbursement_check."], why: "commission splits and the Source of Truth" },
  buyer_attribution: { allowedPrefixes: ["buyer.attribution", "buyer.referral", "agent.attribution", "agent.qr"], why: "referral shares" },
  pending_referral_agreements: { allowedPrefixes: ["agent.nar_referral", "settlement.", "buyer.resident_agent", "buyer.agent", "closing_saga."], why: "referral shares" },
  allocation_overrides: { allowedPrefixes: ["expense.", "capital_call.", "capital.", "admin."], why: "ownership allocation" },
};

export const COVERAGE_LABELS: Record<InventoryStatus, string> = {
  covered: "Already audited",
  fixed_app: "Gap closed: application audit row",
  fixed_db: "Gap closed: database safety net",
  new: "New",
};
