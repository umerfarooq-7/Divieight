import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Post-closing Owner Dashboard. An owner is a user with a cap table row for the
 * property — through their Buyer Account or as a retained seller (the same rule
 * as is_property_owner in owner-dashboard.sql). Owner features open once the
 * Operating Agreement is executed and the Closing Ping Saga has issued the
 * user's Digital Key. Every read here is for one user and one property.
 */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

interface CapRow {
  property_id: string;
  share_number: number;
  holder_type: string;
  buyer_account_id: string | null;
  seller_id: string | null;
  acquisition_date: string;
  retention_lock_expires_at: string;
}

export interface OwnerPropertySummary {
  propertyId: string;
  label: string;
  photo: string | null;
  llcName: string | null;
  shareCount: number;
  active: boolean;
}

export interface OwnerPropertyDetail extends OwnerPropertySummary {
  market: string;
  einStatus: string | null;
  shareNumbers: number[];
  acquisitionDate: string | null;
  /** The latest Retention Lock across this owner's shares. */
  retentionLockExpiresAt: string | null;
  capital: { contributed: number; distributions: number; net: number } | null;
}

export type OwnerPropertyResult =
  | { access: "none" }
  | { access: "inactive"; property: Pick<OwnerPropertySummary, "propertyId" | "label" | "photo" | "shareCount"> }
  | { access: "active"; property: OwnerPropertyDetail };

/** The user's own cap table rows, optionally for one property. */
async function myCapRows(db: Db, userId: string, propertyId?: string): Promise<{ rows: CapRow[]; buyerAccountId: string | null }> {
  const { data: buyer } = await db.from("buyer_accounts").select("id").eq("auth_user_id", userId).maybeSingle();
  const buyerAccountId = (buyer?.id as string | undefined) ?? null;
  const cols = "property_id, share_number, holder_type, buyer_account_id, seller_id, acquisition_date, retention_lock_expires_at";
  const query = (column: string, value: string, holderType: string) => {
    let q = db.from("cap_table_entries").select(cols).eq(column, value).eq("holder_type", holderType);
    if (propertyId) q = q.eq("property_id", propertyId);
    return q;
  };
  const [asBuyer, asSeller] = await Promise.all([
    buyerAccountId ? query("buyer_account_id", buyerAccountId, "buyer_account") : Promise.resolve({ data: [] }),
    query("seller_id", userId, "retained_seller"),
  ]);
  return { rows: [...((asBuyer.data ?? []) as CapRow[]), ...((asSeller.data ?? []) as CapRow[])], buyerAccountId };
}

/** Executed Operating Agreement + this user's active Digital Key on the property. */
async function ownerFeaturesActive(db: Db, propertyId: string, userId: string, buyerAccountId: string | null): Promise<boolean> {
  const { data: genesis } = await db.from("entity_genesis").select("oa_executed_at").eq("property_id", propertyId).maybeSingle();
  if (!genesis?.oa_executed_at) return false;
  const { data: keys } = await db
    .from("co_owner_digital_keys")
    .select("holder_type, buyer_account_id, seller_id")
    .eq("property_id", propertyId)
    .eq("status", "active");
  return ((keys ?? []) as Array<{ holder_type: string; buyer_account_id: string | null; seller_id: string | null }>).some((k) =>
    k.holder_type === "retained_seller" ? k.seller_id === userId : Boolean(buyerAccountId) && k.buyer_account_id === buyerAccountId,
  );
}

async function propertyCard(db: Db, propertyId: string) {
  const { data: p } = await db.from("properties").select("id, address, city, state").eq("id", propertyId).maybeSingle();
  const { data: media } = await db
    .from("property_media")
    .select("url, display_order")
    .eq("property_id", propertyId)
    .eq("media_type", "photo")
    .order("display_order", { ascending: true })
    .limit(1);
  const path = ((media ?? [])[0] as { url: string } | undefined)?.url ?? null;
  let photo: string | null = null;
  if (path) {
    const { resolvePropertyMediaUrls } = await import("@/lib/property-media.server");
    photo = (await resolvePropertyMediaUrls([path])).get(path) ?? null;
  }
  return {
    label: p ? [p.address, p.city, p.state].filter(Boolean).join(", ") : "Your property",
    market: p ? [p.city, p.state].filter(Boolean).join(", ") : "",
    photo,
  };
}

/** Whether to show the Owner entry in the header. */
export const getOwnerNavState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ isOwner: boolean }> => {
    const { rows } = await myCapRows(await adminDb(), context.userId);
    return { isOwner: rows.length > 0 };
  });

/** /owner — one card per property the user holds shares in. */
export const listOwnerProperties = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ properties: OwnerPropertySummary[] }> => {
    const db = await adminDb();
    const { rows, buyerAccountId } = await myCapRows(db, context.userId);
    const out: OwnerPropertySummary[] = [];
    for (const propertyId of [...new Set(rows.map((r) => r.property_id))]) {
      const { label, photo } = await propertyCard(db, propertyId);
      const { data: genesis } = await db.from("entity_genesis").select("llc_name").eq("property_id", propertyId).maybeSingle();
      out.push({
        propertyId,
        label,
        photo,
        llcName: (genesis?.llc_name as string | null) ?? null,
        shareCount: rows.filter((r) => r.property_id === propertyId).length,
        active: await ownerFeaturesActive(db, propertyId, context.userId, buyerAccountId),
      });
    }
    return { properties: out };
  });

/** /owner/properties/:id — nothing about a property the user doesn't own. */
export const getOwnerProperty = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return { propertyId: String(input.propertyId) };
  })
  .handler(async ({ data, context }): Promise<OwnerPropertyResult> => {
    const db = await adminDb();
    const { rows, buyerAccountId } = await myCapRows(db, context.userId, data.propertyId);
    if (rows.length === 0) return { access: "none" };

    const { label, market, photo } = await propertyCard(db, data.propertyId);
    const base = { propertyId: data.propertyId, label, photo, shareCount: rows.length };
    if (!(await ownerFeaturesActive(db, data.propertyId, context.userId, buyerAccountId)))
      return { access: "inactive", property: base };

    const { data: genesis } = await db
      .from("entity_genesis")
      .select("llc_name, ein_status")
      .eq("property_id", data.propertyId)
      .maybeSingle();
    // Empty state (not an error) when there's no row, or before the SQL is run.
    const { data: capitalRow } = await db
      .from("owner_capital_accounts")
      .select("contributed_amount, distributions_amount")
      .eq("property_id", data.propertyId)
      .eq("user_id", context.userId)
      .maybeSingle();
    const contributed = Number(capitalRow?.contributed_amount ?? 0);
    const distributions = Number(capitalRow?.distributions_amount ?? 0);
    const latest = (values: string[]) => (values.length ? values.reduce((a, b) => (new Date(a) >= new Date(b) ? a : b)) : null);
    const earliest = (values: string[]) => (values.length ? values.reduce((a, b) => (new Date(a) <= new Date(b) ? a : b)) : null);

    return {
      access: "active",
      property: {
        ...base,
        market,
        active: true,
        llcName: (genesis?.llc_name as string | null) ?? null,
        einStatus: (genesis?.ein_status as string | null) ?? null,
        shareNumbers: rows.map((r) => r.share_number).sort((a, b) => a - b),
        acquisitionDate: earliest(rows.map((r) => r.acquisition_date)),
        retentionLockExpiresAt: latest(rows.map((r) => r.retention_lock_expires_at)),
        capital: capitalRow ? { contributed, distributions, net: contributed - distributions } : null,
      },
    };
  });
