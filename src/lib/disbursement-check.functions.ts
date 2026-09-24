import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import type { CheckLine, DisbursementCheckResult } from "@/lib/disbursement-check.server";

/** Disbursement Check — admin surface: enter title's numbers, run the check, read the evidence. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

export interface DisbursementCheckView {
  propertyId: string;
  label: string;
  sot: { version: number; hash: string; totalCents: number; payees: Array<{ brokerId: string; brokerageName: string; amountCents: number }> };
  title: { source: string; at: string; figures: Array<{ payeeReference: string; amount: number }> } | null;
  checks: Array<{ id: string; status: string; checked_at: string; title_source: string | null; triggered_by: string | null; report: string | null; lines: CheckLine[] }>;
}

export const listDisbursementChecks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ properties: DisbursementCheckView[] }> => {
    await requireAdmin(context.claims?.sub as string);
    const db = await adminDb();
    const { latestSourceOfTruth } = await import("@/lib/settlement.server");
    const { latestTitleFigures } = await import("@/lib/disbursement-check.server");
    const { data: docs } = await db.from("settlement_documents").select("property_id").eq("status", "transmitted");
    const ids = [...new Set(((docs ?? []) as Array<{ property_id: string }>).map((d) => d.property_id))];
    const out: DisbursementCheckView[] = [];
    for (const id of ids) {
      const sot = await latestSourceOfTruth(db, id);
      if (!sot) continue;
      const { data: p } = await db.from("properties").select("address, city, state").eq("id", id).maybeSingle();
      const { data: checks } = await db
        .from("disbursement_checks")
        .select("id, status, checked_at, title_source, triggered_by, report, lines")
        .eq("property_id", id)
        .order("checked_at", { ascending: false })
        .limit(10);
      out.push({
        propertyId: id,
        label: p ? `${p.address}, ${p.city}, ${p.state}` : id,
        sot: {
          version: sot.version,
          hash: sot.content_hash,
          totalCents: sot.structured.totals.commissionCents,
          payees: sot.structured.payees.map((x) => ({ brokerId: x.brokerId, brokerageName: x.brokerageName, amountCents: x.amountCents })),
        },
        title: await latestTitleFigures(db, id),
        checks: (checks ?? []) as DisbursementCheckView["checks"],
      });
    }
    return { properties: out };
  });

export const saveTitleFigures = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; figures: Array<{ payeeReference: string; amount: number }>; note?: string | null }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    if (!Array.isArray(input.figures) || input.figures.length === 0) throw new Error("Enter at least one line");
    return { ...input, figures: input.figures.map((f) => ({ payeeReference: String(f.payeeReference), amount: Number(f.amount) })) };
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    const { enterTitleFigures } = await import("@/lib/disbursement-check.server");
    return enterTitleFigures(await adminDb(), userId, data.propertyId, data.figures, data.note?.trim() || null);
  });

export const runDisbursementCheckNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return input;
  })
  .handler(async ({ data, context }): Promise<DisbursementCheckResult> => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    const { runDisbursementCheck } = await import("@/lib/disbursement-check.server");
    return runDisbursementCheck(await adminDb(), data.propertyId, { triggeredBy: "admin_manual", actorId: userId });
  });
