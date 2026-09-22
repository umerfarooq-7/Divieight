// Entity Genesis — Stage 1 server routines.
//
// Reacts to Hard-Lock (first 1/8th share reserved). It never changes
// Hard-Lock's own price-freezing logic; it only observes the trigger.
import {
  draftOperatingAgreement,
  placeholderLlcName,
  retentionLockExpiry,
  type CapTableRow,
} from "@/lib/entity-genesis";

type Db = any;

const GENESIS_BUCKET = "property-documents";

async function audit(
  db: Db,
  params: {
    actorId: string;
    actionType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db.from("audit_log").insert({
    actor_id: params.actorId,
    actor_type: "admin",
    action_type: params.actionType,
    entity_type: "entity_genesis",
    entity_id: params.entityId,
    metadata: (params.metadata ?? {}) as never,
  });
}

async function loadProperty(db: Db, propertyId: string) {
  const { data } = await db
    .from("properties")
    .select(
      "id, address, city, state, zip, seller_id, exit_type, retained_shares, hard_locked_at, created_at",
    )
    .eq("id", propertyId)
    .maybeSingle();
  return data as
    | {
        id: string;
        address: string;
        city: string;
        state: string;
        zip: string;
        seller_id: string;
        exit_type: string | null;
        retained_shares: number | null;
        hard_locked_at: string | null;
        created_at: string;
      }
    | null;
}

/** Current holder-by-share picture: retained seller shares first, then reservations by time. */
async function buildCapTable(db: Db, propertyId: string): Promise<CapTableRow[]> {
  const property = await loadProperty(db, propertyId);
  if (!property) return [];

  const retained =
    property.exit_type === "hybrid_exit"
      ? Math.max(0, Math.min(8, property.retained_shares ?? 0))
      : 0;

  const { data: reservations } = await db
    .from("pod_reservations")
    .select("id, buyer_account_id, shares_reserved, reserved_at")
    .eq("property_id", propertyId)
    .eq("status", "reserved")
    .order("reserved_at", { ascending: true });

  const rows: CapTableRow[] = [];
  const retainedDate = property.hard_locked_at ?? property.created_at;

  for (let i = 0; i < retained; i++) {
    rows.push({
      shareNumber: rows.length + 1,
      holderType: "retained_seller",
      buyerAccountId: null,
      sellerId: property.seller_id,
      memberNames: [],
      acquisitionDate: retainedDate,
      retentionLockExpiresAt: retentionLockExpiry(retainedDate),
    });
  }

  const buyerIds = Array.from(
    new Set(((reservations ?? []) as any[]).map((r) => r.buyer_account_id).filter(Boolean)),
  );
  const namesByBuyer = new Map<string, string[]>();
  if (buyerIds.length > 0) {
    const { data: members } = await db
      .from("account_members")
      .select("buyer_account_id, full_name")
      .in("buyer_account_id", buyerIds);
    for (const m of (members ?? []) as any[]) {
      const list = namesByBuyer.get(m.buyer_account_id) ?? [];
      if (m.full_name) list.push(m.full_name);
      namesByBuyer.set(m.buyer_account_id, list);
    }
  }

  for (const r of (reservations ?? []) as any[]) {
    const count = Math.max(1, r.shares_reserved ?? 1);
    for (let i = 0; i < count && rows.length < 8; i++) {
      const acquired = r.reserved_at ?? new Date().toISOString();
      rows.push({
        shareNumber: rows.length + 1,
        holderType: "buyer_account",
        buyerAccountId: r.buyer_account_id,
        sellerId: null,
        memberNames: namesByBuyer.get(r.buyer_account_id) ?? [],
        acquisitionDate: acquired,
        retentionLockExpiresAt: retentionLockExpiry(acquired),
      });
    }
  }

  return rows.slice(0, 8);
}

function fingerprint(rows: CapTableRow[]) {
  return rows
    .map((r) =>
      [
        r.shareNumber,
        r.holderType,
        r.buyerAccountId ?? r.sellerId ?? "",
        // Normalize: Postgres returns "+00:00" offsets, toISOString() returns "Z".
        new Date(r.acquisitionDate).toISOString(),
      ].join(":"),
    )
    .join("|");
}

/**
 * Rewrites the cap table to the CURRENT state of who holds what. Runs on every
 * reservation, withdrawal and substitution acceptance, and logs when it changed.
 */
export async function syncCapTable(
  db: Db,
  params: { propertyId: string; actorId: string; reason: string },
): Promise<{ rows: CapTableRow[]; changed: boolean }> {
  const desired = await buildCapTable(db, params.propertyId);

  const { data: existingRaw } = await db
    .from("cap_table_entries")
    .select("share_number, holder_type, buyer_account_id, seller_id, acquisition_date")
    .eq("property_id", params.propertyId)
    .order("share_number", { ascending: true });

  const existing: CapTableRow[] = ((existingRaw ?? []) as any[]).map((r) => ({
    shareNumber: r.share_number,
    holderType: r.holder_type,
    buyerAccountId: r.buyer_account_id,
    sellerId: r.seller_id,
    memberNames: [],
    acquisitionDate: new Date(r.acquisition_date).toISOString(),
    retentionLockExpiresAt: "",
  }));

  const changed = fingerprint(existing) !== fingerprint(desired);

  await db.from("cap_table_entries").delete().eq("property_id", params.propertyId);
  if (desired.length > 0) {
    const { error: insertError } = await db.from("cap_table_entries").insert(
      desired.map((r) => ({
        property_id: params.propertyId,
        share_number: r.shareNumber,
        holder_type: r.holderType,
        buyer_account_id: r.buyerAccountId,
        seller_id: r.sellerId,
        account_member_names: r.memberNames,
        acquisition_date: r.acquisitionDate,
        retention_lock_expires_at: r.retentionLockExpiresAt,
      })),
    );
    if (insertError) console.error("[entity-genesis] cap table write failed:", insertError.message);
  }

  await db
    .from("entity_genesis")
    .update({ cap_table_generated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("property_id", params.propertyId);

  if (changed) {
    await audit(db, {
      actorId: params.actorId,
      actionType: "entity.cap_table_updated",
      entityId: params.propertyId,
      metadata: {
        reason: params.reason,
        shares_recorded: desired.length,
        retained_shares: desired.filter((r) => r.holderType === "retained_seller").length,
        buyer_shares: desired.filter((r) => r.holderType === "buyer_account").length,
      },
    });
  }

  return { rows: desired, changed };
}

/**
 * Stage 1 — Digital Genesis. Idempotent: creates the standalone Delaware LLC
 * record and its Draft Operating Agreement once, then keeps the cap table live.
 */
export async function ensureDigitalGenesis(
  db: Db,
  params: { propertyId: string; actorId: string; reason: string },
): Promise<{ created: boolean }> {
  const property = await loadProperty(db, params.propertyId);
  if (!property) return { created: false };

  const { data: existing } = await db
    .from("entity_genesis")
    .select("id, draft_operating_agreement_url")
    .eq("property_id", params.propertyId)
    .maybeSingle();

  let created = false;
  let genesisId: string | null = (existing as any)?.id ?? null;
  const llcName = placeholderLlcName(property);

  if (!existing) {
    const { data: inserted } = await db
      .from("entity_genesis")
      .insert({
        property_id: params.propertyId,
        stage: "digital_genesis",
        llc_name: llcName,
        ein: null,
      })
      .select("id")
      .maybeSingle();
    genesisId = (inserted as any)?.id ?? null;
    created = true;
  }

  const { rows } = await syncCapTable(db, {
    propertyId: params.propertyId,
    actorId: params.actorId,
    reason: params.reason,
  });

  if (created) {
    const generatedAt = new Date().toISOString();
    const body = draftOperatingAgreement({
      llcName,
      property,
      capTable: rows,
      generatedAt,
    });
    const path = `entity-genesis/${params.propertyId}/draft-operating-agreement.md`;
    try {
      await db.storage
        .from(GENESIS_BUCKET)
        .upload(path, new Blob([body], { type: "text/markdown" }), {
          upsert: true,
          contentType: "text/markdown",
        });
      await db
        .from("entity_genesis")
        .update({ draft_operating_agreement_url: path })
        .eq("property_id", params.propertyId);
    } catch {
      // The entity record stands even if the document upload fails; the
      // draft can be regenerated before Closing-Ready.
    }

    await audit(db, {
      actorId: params.actorId,
      actionType: "entity.digital_genesis_created",
      entityId: params.propertyId,
      metadata: {
        genesis_id: genesisId,
        llc_name: llcName,
        jurisdiction: "Delaware",
        structure: "standalone_llc",
        manager: "divieight, LLC",
        draft_operating_agreement_path: path,
        trigger: params.reason,
      },
    });
  }

  return { created };
}
