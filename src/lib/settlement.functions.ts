import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import type { SettlementBlocker, SourceOfTruth } from "@/lib/settlement.server";

/** Commission Settlement — admin surface. Produces instructions only; never moves money. */

type Db = { from: (t: string) => any; storage?: any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

export interface SettlementRow {
  propertyId: string;
  label: string;
  blockers: SettlementBlocker[];
  latest: {
    id: string;
    version: number;
    status: string;
    content_hash: string;
    total_commission_cents: number;
    generated_at: string;
    transmitted_at: string | null;
    external_reference: string | null;
    simulated: boolean | null;
    structured: SourceOfTruth;
    pdf_signed_url: string | null;
  } | null;
  versions: number;
}

/** Properties with a title order open or a locked cap table — the ones nearing closing. */
export const listSettlements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: SettlementRow[] }> => {
    await requireAdmin(context.claims?.sub as string);
    const db = await adminDb();
    const s = await import("@/lib/settlement.server");
    const { data: orders } = await db.from("title_escrow_orders").select("property_id");
    const { data: locked } = await db.from("entity_genesis").select("property_id, cap_table_locked_at");
    const ids = [
      ...new Set([
        ...((orders ?? []) as Array<{ property_id: string }>).map((o) => o.property_id),
        ...((locked ?? []) as Array<{ property_id: string; cap_table_locked_at: string | null }>)
          .filter((g) => g.cap_table_locked_at)
          .map((g) => g.property_id),
      ]),
    ];
    const rows: SettlementRow[] = [];
    for (const id of ids) {
      const { data: p } = await db.from("properties").select("address, city, state").eq("id", id).maybeSingle();
      const { data: docs } = await db
        .from("settlement_documents")
        .select("*")
        .eq("property_id", id)
        .order("version", { ascending: false });
      const list = (docs ?? []) as Array<SettlementRow["latest"] & { pdf_url: string | null }>;
      let latest: SettlementRow["latest"] = null;
      if (list[0]) {
        let url: string | null = null;
        if (list[0].pdf_url) {
          try {
            const { data } = await db.storage.from("property-documents").createSignedUrl(list[0].pdf_url, 3600);
            url = data?.signedUrl ?? null;
          } catch {
            url = null;
          }
        }
        latest = { ...list[0], pdf_signed_url: url };
      }
      rows.push({
        propertyId: id,
        label: p ? `${p.address}, ${p.city}, ${p.state}` : "Property",
        blockers: await s.settlementPreconditions(db, id),
        latest,
        versions: list.length,
      });
    }
    return { rows };
  });

export const generateSourceOfTruth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    await requireAdmin(userId);
    const { generateAndTransmit } = await import("@/lib/settlement.server");
    return generateAndTransmit(await adminDb(), userId, data.propertyId);
  });
