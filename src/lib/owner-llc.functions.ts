import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Owner area: the LLC page, and the admin page that feeds it. Governing
 * documents, rules and notices are a floor: any owner of the property can open
 * them whatever the status of the property or their Digital Key (Rev 48). The
 * roster names other people, so it waits until ownership is active.
 */

type Db = { from: (t: string) => any; storage?: any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function requireAdmin(context: { supabase: any; userId: string }) {
  const { data } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

export interface GovernanceRule {
  id: string;
  property_id: string | null;
  section_key: string;
  title: string;
  body: string;
  sort_order: number;
}

export interface OwnerNotice {
  id: string;
  title: string;
  body: string;
  created_at: string;
}

export interface RosterEntry {
  name: string;
  holderLabel: "Co-owner" | "Seller co-owner (retained)";
  shareNumbers: number[];
  acquisitionDate: string;
  isMe: boolean;
}

export interface OwnerLlcPayload {
  access: "owner";
  label: string;
  operatingAgreement: { text: string | null; downloadUrl: string | null; executedAt: string | null; hash: string | null } | null;
  /** Null until ownership is active. */
  roster: RosterEntry[] | null;
  rules: GovernanceRule[];
  notices: OwnerNotice[];
}

/** Property-specific rules first; a property's rule replaces the default with the same key. */
export function orderRules(rows: GovernanceRule[]): GovernanceRule[] {
  const bySort = (a: GovernanceRule, b: GovernanceRule) => a.sort_order - b.sort_order;
  const own = rows.filter((r) => r.property_id).sort(bySort);
  const replaced = new Set(own.map((r) => r.section_key));
  return [...own, ...rows.filter((r) => !r.property_id && !replaced.has(r.section_key)).sort(bySort)];
}

/** Empty (not an error) before owner-llc.sql is run. */
async function rulesFor(db: Db, propertyId: string): Promise<GovernanceRule[]> {
  const { data: defaults } = await db.from("governance_rules").select("*").is("property_id", null);
  const { data: own } = await db.from("governance_rules").select("*").eq("property_id", propertyId);
  return orderRules([...((own ?? []) as GovernanceRule[]), ...((defaults ?? []) as GovernanceRule[])]);
}

async function noticesFor(db: Db, propertyId: string): Promise<OwnerNotice[]> {
  const { data } = await db
    .from("owner_notices")
    .select("id, title, body, created_at")
    .eq("property_id", propertyId)
    .order("created_at", { ascending: false });
  return (data ?? []) as OwnerNotice[];
}

async function executedAgreement(db: Db, propertyId: string): Promise<OwnerLlcPayload["operatingAgreement"]> {
  const { data: g } = await db
    .from("entity_genesis")
    .select("executed_oa_url, final_oa_text, final_oa_hash, oa_executed_at")
    .eq("property_id", propertyId)
    .maybeSingle();
  if (!g?.executed_oa_url) return null;

  let text: string | null = (g.final_oa_text as string | null) ?? null;
  let downloadUrl: string | null = null;
  try {
    const bucket = db.storage?.from("property-documents");
    const file = await bucket?.download?.(g.executed_oa_url);
    if (file?.data) text = await file.data.text(); // includes the signature page
    const signed = await bucket?.createSignedUrl(g.executed_oa_url, 3600, { download: true });
    downloadUrl = signed?.data?.signedUrl ?? null;
  } catch {
    // The agreement's text still shows if the file can't be reached.
  }
  return { text, downloadUrl, executedAt: g.oa_executed_at ?? null, hash: g.final_oa_hash ?? null };
}

/** Names, share numbers and dates only — never contact, budget or financial data. */
async function rosterFor(db: Db, propertyId: string, myBuyerAccountId: string | null, userId: string): Promise<RosterEntry[]> {
  const { data } = await db
    .from("cap_table_entries")
    .select("share_number, holder_type, buyer_account_id, seller_id, account_member_names, acquisition_date")
    .eq("property_id", propertyId)
    .order("share_number", { ascending: true });
  const rows = (data ?? []) as Array<{
    share_number: number;
    holder_type: string;
    buyer_account_id: string | null;
    seller_id: string | null;
    account_member_names: string[] | null;
    acquisition_date: string;
  }>;
  const holders = new Map<string, RosterEntry>();
  for (const r of rows) {
    const seller = r.holder_type === "retained_seller";
    const key = `${r.holder_type}:${seller ? r.seller_id : r.buyer_account_id}`;
    const entry = holders.get(key);
    if (entry) {
      entry.shareNumbers.push(r.share_number);
      if (new Date(r.acquisition_date) < new Date(entry.acquisitionDate)) entry.acquisitionDate = r.acquisition_date;
      continue;
    }
    let name = (r.account_member_names ?? []).filter(Boolean).join(" & ");
    if (!name && seller && r.seller_id) {
      const { data: s } = await db.from("sellers").select("full_name").eq("id", r.seller_id).maybeSingle();
      name = (s?.full_name as string | null) ?? "";
    }
    holders.set(key, {
      name: name || (seller ? "Seller" : "Co-owner"),
      holderLabel: seller ? "Seller co-owner (retained)" : "Co-owner",
      shareNumbers: [r.share_number],
      acquisitionDate: r.acquisition_date,
      isMe: seller ? r.seller_id === userId : Boolean(myBuyerAccountId) && r.buyer_account_id === myBuyerAccountId,
    });
  }
  return [...holders.values()];
}

/** /owner/properties/:id/llc */
export const getOwnerLlc = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return { propertyId: String(input.propertyId) };
  })
  .handler(async ({ data, context }): Promise<OwnerLlcPayload | { access: "none" }> => {
    const db = await adminDb();
    const { loadOwnerProperty } = await import("@/lib/owner.functions");
    const ownership = await loadOwnerProperty(db, context.userId, data.propertyId);
    if (ownership.access === "none") return { access: "none" };

    const { data: buyer } = await db.from("buyer_accounts").select("id").eq("auth_user_id", context.userId).maybeSingle();
    return {
      access: "owner",
      label: ownership.property.label,
      operatingAgreement: await executedAgreement(db, data.propertyId),
      roster:
        ownership.access === "active"
          ? await rosterFor(db, data.propertyId, (buyer?.id as string | undefined) ?? null, context.userId)
          : null,
      rules: await rulesFor(db, data.propertyId),
      notices: await noticesFor(db, data.propertyId),
    };
  });

/** /admin/properties/:id/governance */
export const getAdminGovernance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return { propertyId: String(input.propertyId) };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await adminDb();
    const { data: p } = await db.from("properties").select("address, city, state").eq("id", data.propertyId).maybeSingle();
    if (!p) throw new Error("Property not found");
    return {
      label: [p.address, p.city, p.state].filter(Boolean).join(", "),
      rules: await rulesFor(db, data.propertyId),
      notices: await noticesFor(db, data.propertyId),
    };
  });

const cleanText = (value: unknown, label: string, max: number) => {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > max) throw new Error(`${label} must be under ${max} characters`);
  return text;
};

/**
 * Create or update this property's rule. Saving a default creates the property's
 * own copy under the same key: a default is never changed from a property's page.
 */
export const saveGovernanceRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; sectionKey?: string | null; title: string; body: string; sortOrder?: number }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return {
      propertyId: String(input.propertyId),
      sectionKey: input.sectionKey ? String(input.sectionKey) : null,
      title: cleanText(input.title, "Title", 200),
      body: cleanText(input.body, "Text", 10000),
      sortOrder: Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : null,
    };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await adminDb();
    const { data: property } = await db.from("properties").select("id").eq("id", data.propertyId).maybeSingle();
    if (!property) throw new Error("Property not found");

    const sectionKey = data.sectionKey ?? `custom_${crypto.randomUUID().slice(0, 8)}`;
    const { data: existing } = await db
      .from("governance_rules")
      .select("id, sort_order")
      .eq("property_id", data.propertyId)
      .eq("section_key", sectionKey)
      .maybeSingle();
    const now = new Date().toISOString();
    if (existing) {
      const { error } = await db
        .from("governance_rules")
        .update({ title: data.title, body: data.body, sort_order: data.sortOrder ?? existing.sort_order, updated_at: now })
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await db.from("governance_rules").insert({
        property_id: data.propertyId,
        section_key: sectionKey,
        title: data.title,
        body: data.body,
        sort_order: data.sortOrder ?? 0,
        updated_at: now,
      });
      if (error) throw new Error(/governance_rules/.test(error.message) ? "Database is missing governance_rules — run owner-llc.sql in Supabase." : error.message);
    }
    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "admin",
      action_type: "governance.rule_saved",
      entity_type: "property",
      entity_id: data.propertyId,
      metadata: { section_key: sectionKey },
    });
    return { ok: true };
  });

/** Remove this property's own rule; a default with the same key shows again. */
export const deleteGovernanceRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; sectionKey: string }) => {
    if (!input?.propertyId || !input?.sectionKey) throw new Error("Missing rule");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await adminDb();
    // Scoped to the property, so a default row can never be deleted here.
    await db.from("governance_rules").delete().eq("property_id", data.propertyId).eq("section_key", data.sectionKey);
    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "admin",
      action_type: "governance.rule_removed",
      entity_type: "property",
      entity_id: data.propertyId,
      metadata: { section_key: data.sectionKey },
    });
    return { ok: true };
  });

export const postOwnerNotice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { propertyId: string; title: string; body: string }) => {
    if (!input?.propertyId) throw new Error("Missing property");
    return {
      propertyId: String(input.propertyId),
      title: cleanText(input.title, "Title", 200),
      body: cleanText(input.body, "Text", 10000),
    };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    const db = await adminDb();
    const { data: property } = await db.from("properties").select("id").eq("id", data.propertyId).maybeSingle();
    if (!property) throw new Error("Property not found");
    const { error } = await db.from("owner_notices").insert({
      property_id: data.propertyId,
      title: data.title,
      body: data.body,
      created_by: context.userId,
    });
    if (error) throw new Error(/owner_notices/.test(error.message) ? "Database is missing owner_notices — run owner-llc.sql in Supabase." : error.message);
    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: "admin",
      action_type: "governance.notice_posted",
      entity_type: "property",
      entity_id: data.propertyId,
      metadata: { title: data.title },
    });
    return { ok: true };
  });
