import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { AUTHORIZATION_ACTION_LABELS } from "@/lib/authorization";
import { authorizationsAwaitingBuyer, diligenceGateStatus } from "@/lib/authorization.functions";
import { money } from "@/lib/earnest-money";

/**
 * Buyer dashboard summary — read only. Collects what is waiting on the Buyer
 * Account across its reservations, and each reservation's progress through the
 * transaction. Every rule comes from the module that owns it (DD gate,
 * authorization stage, funding obligations, Operating Agreement signatures).
 */

type Db = { from: (t: string) => any };

export type BuyerActionKind =
  | "due_diligence"
  | "authorization"
  | "earnest_money"
  | "closing_funds"
  | "operating_agreement";

export interface BuyerAction {
  kind: BuyerActionKind;
  propertyId: string;
  propertyLabel: string;
  title: string;
  detail: string | null;
  dueAt: string | null;
  overdue: boolean;
  /** Authorization request id, for the single-request page. */
  requestId: string | null;
}

export type ProgressState = "done" | "current" | "todo";
export interface ProgressStep {
  key: string;
  label: string;
  state: ProgressState;
}

export interface BuyerActionsPayload {
  actions: BuyerAction[];
  progress: Record<string, ProgressStep[]>;
}

const OFFER_ACTIONS = ["offer_tender", "counter_offer_acceptance", "final_repa_acceptance"];

const STEP_ORDER: Array<[string, string]> = [
  ["due_diligence", "Due diligence"],
  ["offer", "Offer authorized"],
  ["earnest_money", "Earnest money"],
  ["operating_agreement", "Operating Agreement"],
  ["closing_funds", "Closing funds"],
  ["closed", "Closed"],
];

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

/** Done steps as reported; the first step not done is "current". */
export function progressSteps(done: Record<string, boolean>): ProgressStep[] {
  let currentSet = false;
  return STEP_ORDER.map(([key, label]) => {
    if (done[key]) return { key, label, state: "done" as const };
    if (!currentSet) {
      currentSet = true;
      return { key, label, state: "current" as const };
    }
    return { key, label, state: "todo" as const };
  });
}

type Obligation = { property_id: string; amount: number; status: string; funding_deadline: string };

export async function buyerActionItems(db: Db, buyerAccountId: string): Promise<BuyerActionsPayload> {
  const { data: res } = await db
    .from("pod_reservations")
    .select("property_id")
    .eq("buyer_account_id", buyerAccountId)
    .eq("status", "reserved");
  const propertyIds = [...new Set(((res ?? []) as Array<{ property_id: string }>).map((r) => r.property_id))];
  if (propertyIds.length === 0) return { actions: [], progress: {} };

  const { data: props } = await db
    .from("properties")
    .select("id, address, city, listing_status")
    .in("id", propertyIds);
  const propById = new Map(
    ((props ?? []) as Array<{ id: string; address: string | null; city: string | null; listing_status: string | null }>).map(
      (p) => [p.id, p],
    ),
  );
  const labelOf = (id: string) => {
    const p = propById.get(id);
    return p ? [p.address, p.city].filter(Boolean).join(", ") : "Your home";
  };

  const now = Date.now();
  const actions: BuyerAction[] = [];
  const progress: Record<string, ProgressStep[]> = {};

  const awaiting = await authorizationsAwaitingBuyer(db as never, buyerAccountId);
  const { data: offers } = await db
    .from("authorization_requests")
    .select("property_id, action_type, status")
    .eq("buyer_account_id", buyerAccountId)
    .eq("status", "authorized")
    .in("action_type", OFFER_ACTIONS);
  const offerDone = new Set(((offers ?? []) as Array<{ property_id: string }>).map((o) => o.property_id));

  const obligations = async (table: string): Promise<Obligation[]> => {
    const { data } = await db
      .from(table)
      .select("property_id, amount, status, funding_deadline")
      .eq("buyer_account_id", buyerAccountId)
      .in("property_id", propertyIds);
    return (data ?? []) as Obligation[];
  };
  const earnest = await obligations("earnest_money_obligations");
  const closing = await obligations("closing_funds_obligations");
  const { data: memberRows } = await db.from("account_members").select("id").eq("buyer_account_id", buyerAccountId);
  const memberIds = ((memberRows ?? []) as Array<{ id: string }>).map((m) => m.id);

  for (const pid of propertyIds) {
    const label = labelOf(pid);
    const closed = propById.get(pid)?.listing_status === "active";

    // Due diligence — the buyer side of the Prompt 2 gate.
    const { data: ddDocs } = await db.from("due_diligence_inventory").select("id").eq("property_id", pid);
    const gate = await diligenceGateStatus(db as never, pid, buyerAccountId);
    const buyerDdPending = gate.blocker === "buyer" || gate.blocker === "both";
    if (buyerDdPending && !closed)
      actions.push({
        kind: "due_diligence",
        propertyId: pid,
        propertyLabel: label,
        title: "Review and acknowledge due-diligence documents",
        detail: "Required before you can act on authorization requests.",
        dueAt: null,
        overdue: false,
        requestId: null,
      });

    // Authorizations waiting on this account — the DD item comes first while it blocks them.
    if (!buyerDdPending)
      for (const a of awaiting.filter((x) => x.property_id === pid)) {
        actions.push({
          kind: "authorization",
          propertyId: pid,
          propertyLabel: label,
          title:
            a.stage === "commission_members"
              ? "Authorize the commission provision"
              : `Authorize: ${AUTHORIZATION_ACTION_LABELS[a.action_type] ?? a.action_type}`,
          detail: null,
          dueAt: a.deadline_at,
          overdue: new Date(a.deadline_at).getTime() < now,
          requestId: a.id,
        });
      }

    // Funding obligations still open.
    const funding: Array<[BuyerActionKind, Obligation[], string]> = [
      ["earnest_money", earnest, "earnest money"],
      ["closing_funds", closing, "closing funds"],
    ];
    for (const [kind, list, noun] of funding) {
      for (const o of list.filter((x) => x.property_id === pid && (x.status === "pending" || x.status === "late"))) {
        actions.push({
          kind,
          propertyId: pid,
          propertyLabel: label,
          title: `Fund ${money(Number(o.amount))} ${noun}`,
          detail: "Send it to the title/escrow company using your funding instruction.",
          dueAt: o.funding_deadline,
          overdue: o.status === "late" || new Date(o.funding_deadline).getTime() < now,
          requestId: null,
        });
      }
    }

    // Operating Agreement — this account's members who haven't signed the final OA.
    const { data: g } = await db
      .from("entity_genesis")
      .select("id, final_oa_status, final_oa_hash")
      .eq("property_id", pid)
      .maybeSingle();
    const oaDone = g?.final_oa_status === "executed";
    if (!oaDone && g?.final_oa_status === "awaiting_signatures" && g.final_oa_hash) {
      const { data: sigs } = await db
        .from("operating_agreement_signatures")
        .select("account_member_id")
        .eq("entity_genesis_id", g.id)
        .eq("document_hash", g.final_oa_hash);
      const signed = new Set(((sigs ?? []) as Array<{ account_member_id: string }>).map((x) => x.account_member_id));
      const unsigned = memberIds.filter((id) => !signed.has(id)).length;
      if (unsigned > 0)
        actions.push({
          kind: "operating_agreement",
          propertyId: pid,
          propertyLabel: label,
          title: "Sign the final Operating Agreement",
          detail: `${unsigned} member${unsigned === 1 ? "" : "s"} of your account still to sign.`,
          dueAt: null,
          overdue: false,
          requestId: null,
        });
    }

    const funded = (list: Obligation[]) => {
      const mine = list.filter((x) => x.property_id === pid);
      return mine.length > 0 && mine.every((x) => x.status === "funded");
    };
    progress[pid] = progressSteps({
      due_diligence: closed || (((ddDocs ?? []) as unknown[]).length > 0 && gate.clear),
      offer: closed || offerDone.has(pid),
      earnest_money: closed || funded(earnest),
      operating_agreement: closed || oaDone,
      closing_funds: closed || funded(closing),
      closed,
    });
  }

  actions.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const dbt = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    return da - dbt;
  });
  return { actions, progress };
}

export const getBuyerActionItems = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BuyerActionsPayload> => {
    const db = await adminDb();
    const { data: buyer } = await db
      .from("buyer_accounts")
      .select("id")
      .eq("auth_user_id", context.claims?.sub as string)
      .maybeSingle();
    if (!buyer) return { actions: [], progress: {} };
    return buyerActionItems(db, buyer.id);
  });
