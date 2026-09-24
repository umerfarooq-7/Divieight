import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Post-closing ownership (Prompt 17). A Buyer Account becomes a Co-owner of a
 * property when the Closing Ping Saga issues it an active Digital Key; from
 * then on it sees the property's Records Vault for the life of its ownership.
 */

type Db = { from: (t: string) => any; storage?: any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

export interface OwnedProperty {
  propertyId: string;
  label: string;
  llcName: string | null;
  shares: number;
  since: string;
}

async function ownedBy(db: Db, authUserId: string): Promise<OwnedProperty[]> {
  const { data: buyer } = await db.from("buyer_accounts").select("id").eq("auth_user_id", authUserId).maybeSingle();
  if (!buyer) return [];
  const { data: keys } = await db
    .from("co_owner_digital_keys")
    .select("property_id, shares, issued_at")
    .eq("buyer_account_id", buyer.id)
    .eq("holder_type", "buyer_account")
    .eq("status", "active");
  const list = (keys ?? []) as Array<{ property_id: string; shares: number; issued_at: string }>;
  const out: OwnedProperty[] = [];
  for (const k of list) {
    const { data: p } = await db.from("properties").select("address, city, state").eq("id", k.property_id).maybeSingle();
    const { data: g } = await db.from("entity_genesis").select("llc_name").eq("property_id", k.property_id).maybeSingle();
    out.push({
      propertyId: k.property_id,
      label: p ? `${p.address}, ${p.city}, ${p.state}` : "Your property",
      llcName: g?.llc_name ?? null,
      shares: k.shares,
      since: k.issued_at,
    });
  }
  return out;
}

export const getMyOwnership = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ isCoOwner: boolean; properties: OwnedProperty[] }> => {
    const properties = await ownedBy(await adminDb(), context.claims?.sub as string);
    return { isCoOwner: properties.length > 0, properties };
  });

/** Order in which a closing's documents are presented. */
export const VAULT_DOCUMENT_LABELS: Record<string, string> = {
  recorded_deed: "Recorded Deed",
  closing_statement: "Closing Statement",
  executed_operating_agreement: "Executed Operating Agreement",
  certificate_of_formation: "Certificate of Formation",
  ein_confirmation: "IRS EIN confirmation",
  source_of_truth_cda: "Source of Truth / Commission Disbursement Authorization",
};

export interface VaultDocument {
  id: string;
  documentType: string;
  label: string;
  title: string | null;
  storedAt: string;
  url: string | null;
}

/** The co-owner's Property Records Vault — only for properties they hold an active Digital Key to. */
export const listMyPropertyRecords = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ properties: Array<OwnedProperty & { documents: VaultDocument[] }> }> => {
    const db = await adminDb();
    const owned = await ownedBy(db, context.claims?.sub as string);
    const order = Object.keys(VAULT_DOCUMENT_LABELS);
    const out = [];
    for (const o of owned) {
      const { data } = await db
        .from("property_records_vault")
        .select("id, document_type, title, file_url, stored_at")
        .eq("property_id", o.propertyId)
        .order("stored_at", { ascending: true });
      const rows = (data ?? []) as Array<{ id: string; document_type: string; title: string | null; file_url: string; stored_at: string }>;
      const signed = new Map<string, string>();
      if (rows.length) {
        try {
          const { data: urls } = await db.storage.from("property-documents").createSignedUrls(rows.map((r) => r.file_url), 3600);
          for (const u of (urls ?? []) as Array<{ path: string; signedUrl: string }>) if (u.signedUrl) signed.set(u.path, u.signedUrl);
        } catch {
          // listed without links
        }
      }
      // Latest version of each document type first in the fixed order; superseded versions follow.
      const documents = rows
        .map((r) => ({
          id: r.id,
          documentType: r.document_type,
          label: VAULT_DOCUMENT_LABELS[r.document_type] ?? r.document_type.replace(/_/g, " "),
          title: r.title,
          storedAt: r.stored_at,
          url: signed.get(r.file_url) ?? null,
        }))
        .sort((a, b) => {
          const ia = order.indexOf(a.documentType);
          const ib = order.indexOf(b.documentType);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || Date.parse(b.storedAt) - Date.parse(a.storedAt);
        });
      out.push({ ...o, documents });
    }
    return { properties: out };
  });
