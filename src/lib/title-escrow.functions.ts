import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import { TITLE_MILESTONES, nextMilestone, type TitleMilestone, type TitleStatus } from "@/lib/title-escrow";

/** Title/Escrow Handshake — admin simulation panel + read-only status for every dashboard. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function isAdmin(userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  return Boolean(data);
}

async function requireAdmin(userId: string) {
  if (!(await isAdmin(userId))) throw new Error("Not authorized");
}

const server = () => import("@/lib/title-escrow.server");

// ---------------------------------------------------------------------------
// Admin panel
// ---------------------------------------------------------------------------

export interface AdminTitleRow {
  propertyId: string;
  label: string;
  acceptanceAuthorized: boolean;
  order: { provider: string; external_order_id: string; simulated: boolean; status: string; bundle_sent_at: string } | null;
  status: TitleStatus;
  next: TitleMilestone | null;
  earnest: Array<{ buyerAccountId: string; amount: number; status: string }>;
}

export interface AdminDiscrepancy {
  id: string;
  property_id: string;
  kind: string;
  buyer_account_id: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form jsonb
  details: Record<string, any>;
  status: string;
  created_at: string;
  label: string;
}

export const listTitleEscrowAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: AdminTitleRow[]; discrepancies: AdminDiscrepancy[]; webhookConfigured: boolean }> => {
    await requireAdmin(context.claims?.sub as string);
    const db = await adminDb();
    const s = await server();
    const { data: res } = await db.from("pod_reservations").select("property_id").eq("status", "reserved");
    const { data: orders } = await db.from("title_escrow_orders").select("*");
    const ids = [
      ...new Set([
        ...((res ?? []) as Array<{ property_id: string }>).map((r) => r.property_id),
        ...((orders ?? []) as Array<{ property_id: string }>).map((o) => o.property_id),
      ]),
    ];
    const { data: props } = ids.length ? await db.from("properties").select("id, address, city, state").in("id", ids) : { data: [] };
    const label = new Map(((props ?? []) as Array<{ id: string; address: string; city: string; state: string }>).map((p) => [p.id, `${p.address}, ${p.city}, ${p.state}`]));

    const rows: AdminTitleRow[] = [];
    for (const id of ids) {
      const status = await s.titleStatus(db, id);
      const { data: earnest } = await db.from("earnest_money_obligations").select("buyer_account_id, amount, status").eq("property_id", id);
      rows.push({
        propertyId: id,
        label: label.get(id) ?? "Property",
        acceptanceAuthorized: Boolean(await s.sellerAcceptanceAuthorized(db, id)),
        order:
          ((orders ?? []) as Array<NonNullable<AdminTitleRow["order"]> & { property_id: string }>).find(
            (o) => o.property_id === id,
          ) ?? null,
        status,
        next: nextMilestone(status.milestones.filter((m) => m.receivedAt).map((m) => m.milestone)),
        earnest: ((earnest ?? []) as Array<{ buyer_account_id: string; amount: number; status: string }>).map((e) => ({
          buyerAccountId: e.buyer_account_id,
          amount: Number(e.amount),
          status: e.status,
        })),
      });
    }

    const { data: disc } = await db
      .from("title_escrow_discrepancies")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    return {
      rows,
      discrepancies: ((disc ?? []) as AdminDiscrepancy[]).map((d) => ({ ...d, label: label.get(d.property_id) ?? "Property" })),
      webhookConfigured: Boolean(process.env.QUALIA_WEBHOOK_SECRET),
    };
  });

export const sendTitleClosingBundle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; manualOverrideReason?: string | null }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    return (await server()).sendClosingBundle(await adminDb(), userId, data.propertyId, {
      manualOverrideReason: data.manualOverrideReason ?? null,
    });
  });

export type DepositScenario = "match_platform" | "all_obligations" | "none";

export const simulateTitleMilestone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      propertyId: string;
      milestone: TitleMilestone;
      depositScenario?: DepositScenario;
      closingDate?: string | null;
      /** funded_and_recorded: shift the first payee by this many cents to simulate a title mismatch. */
      commissionVarianceCents?: number;
    }) => {
      if (!input?.propertyId) throw new Error("Missing property");
      if (!TITLE_MILESTONES.includes(input.milestone)) throw new Error("Unknown milestone");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    const db = await adminDb();
    let deposits: Array<{ buyerAccountId: string; amount: number }> = [];
    let allDepositsComplete = false;
    if (data.milestone === "earnest_money_deposited") {
      const { data: obligations } = await db
        .from("earnest_money_obligations")
        .select("buyer_account_id, amount, status")
        .eq("property_id", data.propertyId);
      const list = (obligations ?? []) as Array<{ buyer_account_id: string; amount: number; status: string }>;
      const scenario = data.depositScenario ?? "match_platform";
      const chosen = scenario === "none" ? [] : scenario === "all_obligations" ? list : list.filter((o) => o.status === "funded");
      deposits = chosen.map((o) => ({ buyerAccountId: o.buyer_account_id, amount: Number(o.amount) }));
      allDepositsComplete = list.length > 0 && chosen.length === list.length;
    }
    let commissionDisbursements: Array<{ payeeReference: string; amount: number }> = [];
    if (data.milestone === "funded_and_recorded") {
      const { latestSourceOfTruth } = await import("@/lib/settlement.server");
      const sot = await latestSourceOfTruth(db, data.propertyId);
      const variance = Math.round(Number(data.commissionVarianceCents ?? 0));
      commissionDisbursements = (sot?.structured.payees ?? []).map((p, i) => ({
        payeeReference: p.brokerId,
        amount: (p.amountCents + (i === 0 ? variance : 0)) / 100,
      }));
    }
    return (await server()).simulateMilestone(db, userId, data.propertyId, data.milestone, {
      deposits,
      allDepositsComplete,
      closingDate: data.closingDate ?? null,
      commissionDisbursements,
    });
  });

export const resolveTitleDiscrepancy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { discrepancyId: string; note: string }) => {
    if (!input?.discrepancyId) throw new Error("Missing discrepancy");
    if (!input.note?.trim()) throw new Error("Explain how it was resolved");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    await (await server()).resolveDiscrepancy(await adminDb(), userId, data.discrepancyId, data.note.trim());
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// Read-only status for Buyer, Seller, Resident Agent and HLA dashboards
// ---------------------------------------------------------------------------

export const getTitleStatusFor = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId?: string; podId?: string }) => {
    if (!input?.propertyId && !input?.podId) throw new Error("Missing property");
    return input;
  })
  .handler(async ({ data, context }): Promise<TitleStatus | null> => {
    const userId = context.claims?.sub as string;
    const db = await adminDb();
    let propertyId = data.propertyId ?? null;
    if (!propertyId && data.podId) {
      const { data: pod } = await db.from("pods").select("property_id").eq("id", data.podId).maybeSingle();
      propertyId = pod?.property_id ?? null;
    }
    if (!propertyId) return null;
    const s = await server();
    if (!(await s.canViewTitleStatus(db, userId, propertyId, await isAdmin(userId)))) return null;
    return s.titleStatus(db, propertyId);
  });

/** Title status for every property a Resident Agent's tethered buyers are in. */
export const listAgentTitleStatuses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: Array<{ label: string; status: TitleStatus }> }> => {
    const db = await adminDb();
    const { data: agent } = await db.from("agents").select("id").eq("auth_user_id", context.claims?.sub as string).maybeSingle();
    if (!agent) return { rows: [] };
    const { data: buyers } = await db.from("buyer_accounts").select("id").eq("tethered_resident_agent_id", agent.id);
    const buyerIds = ((buyers ?? []) as Array<{ id: string }>).map((b) => b.id);
    if (!buyerIds.length) return { rows: [] };
    const { data: res } = await db.from("pod_reservations").select("property_id").in("buyer_account_id", buyerIds).eq("status", "reserved");
    const ids = [...new Set(((res ?? []) as Array<{ property_id: string }>).map((r) => r.property_id))];
    const { data: orders } = ids.length ? await db.from("title_escrow_orders").select("property_id").in("property_id", ids) : { data: [] };
    const withOrders = ((orders ?? []) as Array<{ property_id: string }>).map((o) => o.property_id);
    if (!withOrders.length) return { rows: [] };
    const { data: props } = await db.from("properties").select("id, address, city, state").in("id", withOrders);
    const s = await server();
    const rows = [];
    for (const p of (props ?? []) as Array<{ id: string; address: string; city: string; state: string }>)
      rows.push({ label: `${p.address}, ${p.city}, ${p.state}`, status: await s.titleStatus(db, p.id) });
    return { rows };
  });
