/**
 * Launch readiness: every placeholder or simulated part of the app, with a status, an owner and notes. The list is here;
 * the statuses, owners and notes an admin edits are stored (launch_readiness_items) and win over these defaults. Only a
 * founder can see or change them.
 */

export const LAUNCH_STATUSES = ["Placeholder", "Simulated", "Test mode", "Needs counsel", "Done"] as const;
export type LaunchStatus = (typeof LAUNCH_STATUSES)[number];
export const isLaunchStatus = (s: unknown): s is LaunchStatus => typeof s === "string" && (LAUNCH_STATUSES as readonly string[]).includes(s);

export interface LaunchItemDefinition {
  key: string;
  group: "Payments and integrations" | "Legal and compliance" | "Content" | "Security";
  title: string;
  status: LaunchStatus;
  /** What is still to do, in a sentence. */
  detail: string;
}

export const LAUNCH_ITEMS: LaunchItemDefinition[] = [
  { key: "stripe_test_mode", group: "Payments and integrations", title: "Stripe: test mode", status: "Test mode", detail: "The site runs on a Stripe test key (sk_test_). Real fees can't be charged until the live key is in place." },
  { key: "stripe_webhook", group: "Payments and integrations", title: "Stripe: webhook", status: "Placeholder", detail: "A fee only counts as cleared if the buyer returns to the site after paying. A Stripe webhook isn't built yet." },
  { key: "stripe_live_keys", group: "Payments and integrations", title: "Stripe: live keys", status: "Placeholder", detail: "Swap STRIPE_SECRET_KEY and the webhook secret for the live ones, and run one real payment end to end." },
  { key: "title_escrow", group: "Payments and integrations", title: "Title and escrow", status: "Simulated", detail: "Closings run through a simulated Qualia adapter (no credentials). Real orders and webhooks need the provider's credentials." },
  { key: "liveness_vendor", group: "Payments and integrations", title: "Liveness vendor", status: "Simulated", detail: "The selfie check is a simulated vendor. Choose a vendor and add its adapter before real members are cleared." },
  { key: "sanctions_vendor", group: "Payments and integrations", title: "Sanctions vendor", status: "Simulated", detail: "Sanctions and watchlist screening is a simulated vendor. Choose a vendor and add its adapter." },
  { key: "plaid", group: "Payments and integrations", title: "Plaid", status: "Test mode", detail: "Liquidity linking uses Plaid sandbox balances. Production Plaid credentials and the real Link flow are needed." },
  { key: "insurance_minimums", group: "Legal and compliance", title: "Insurance coverage minimums", status: "Placeholder", detail: "The coverage minimums are placeholders. Compliance has to supply the real figures." },
  { key: "oa_draft_clauses", group: "Legal and compliance", title: "Operating Agreement draft clauses", status: "Needs counsel", detail: "Clauses 4.4 (Retention Lock exceptions) and 6.2 (right of first refusal and the resale fee) are marked 'DRAFT: pending counsel review'." },
  { key: "governance_thresholds", group: "Legal and compliance", title: "Governance thresholds", status: "Placeholder", detail: "The voting thresholds, windows and quotas are the decided working numbers, still pending the final Operating Agreement." },
  { key: "standard_q5_copy", group: "Legal and compliance", title: "Participant Eligibility Standard and the Q5 authorization copy", status: "Needs counsel", detail: "The Standard, the six questions and the Question 5 authorization wording need counsel's sign-off before real use." },
  { key: "adverse_action_template", group: "Legal and compliance", title: "Adverse-action notice template", status: "Needs counsel", detail: "The template in src/lib/adverse-action.ts must be reviewed by counsel before it is ever issued." },
  { key: "kyo_list", group: "Legal and compliance", title: "Know Your Owner sensitive-data list", status: "Needs counsel", detail: "The sensitive-data list and the retention wording are pending compliance review." },
  { key: "joint_interest", group: "Legal and compliance", title: "Joint-interest wording", status: "Needs counsel", detail: "The form of joint ownership for two members of one account is pending counsel." },
  { key: "usage_adjusted_allocation", group: "Legal and compliance", title: "Usage-adjusted expense allocation", status: "Placeholder", detail: "ASSUMPTION: the Operating Agreement has not defined a usage-adjusted formula, so the platform calculates nothing. The Manager enters the percentages by hand (Expense allocation tab). Replace with a formula once the OA defines one." },
  { key: "distribution_minimum_reserve", group: "Legal and compliance", title: "Distribution minimum reserve", status: "Placeholder", detail: "ASSUMPTION: the minimum cash a property keeps before it distributes is a $1,000 placeholder. The Manager sets the real figure for each property (Distributions screen) once the Operating Agreement or the CPA names one." },
  { key: "ach_disbursements", group: "Payments and integrations", title: "ACH disbursements to owners", status: "Placeholder", detail: "Distributions are paid through a simulated ACH rail: nothing leaves any bank account, and bank details are tokenized by the simulator. Replace the adapter (src/lib/disbursement-adapters) with a real provider before paying real owners." },
  { key: "statement_holiday_calendar", group: "Legal and compliance", title: "Statement schedule holiday calendar", status: "Placeholder", detail: "ASSUMPTION: no holiday calendar has been chosen, so the monthly statement schedule (first business day, first business week) skips weekends only. Add the real calendar in src/lib/statements.ts before relying on the deadline." },
  { key: "learning_library", group: "Content", title: "Learning Library", status: "Placeholder", detail: "Seeded with placeholder cluster names and no videos, pending compliance review of the content." },
  { key: "w9_encryption_key", group: "Security", title: "W-9 encryption key", status: "Placeholder", detail: "W9_TIN_ENCRYPTION_KEY was committed by mistake and removed. Rotate it in Vercel before any real tax data is stored." },
];

export const LAUNCH_ITEM_KEYS = LAUNCH_ITEMS.map((i) => i.key);

export interface LaunchItemView extends LaunchItemDefinition {
  owner: string;
  notes: string;
  updatedAt: string | null;
}

/** A warning shown to admins only. */
export interface LaunchWarning {
  key: string;
  message: string;
}
