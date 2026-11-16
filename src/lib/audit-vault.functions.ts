import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { VaultFilters } from "@/lib/audit-vault.server";

/** Callable surface for the Audit Vault. The Manager, the Compliance Officer and auditors read it, read-only, and every read is logged. Anyone else gets a 403. */

type Db = Parameters<(typeof import("@/lib/audit-vault.server"))["readVault"]>[0];

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}
const server = () => import("@/lib/audit-vault.server");

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

/** Turns a refusal into a 403 for the screen. */
async function forbidOr<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && e.message === "Not authorized") {
      const { setResponseStatus } = await import("@tanstack/react-start/server");
      setResponseStatus(403);
    }
    throw e;
  }
}

const text = (v: unknown, max: number) => (v ? String(v).slice(0, max) : null);
const day = (v: unknown) => {
  const t = text(v, 40);
  if (t && Number.isNaN(new Date(t).getTime())) throw new Error("Enter a valid date");
  return t;
};

export const getAuditVault = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { filters?: VaultFilters; limit?: number } | undefined) => ({
    filters: { action: text(input?.filters?.action, 120), actor: text(input?.filters?.actor, 64), entity: text(input?.filters?.entity, 120), from: day(input?.filters?.from), to: day(input?.filters?.to) } as VaultFilters,
    limit: input?.limit ? Math.min(1000, Math.max(1, Math.round(Number(input.limit)))) : 200,
  }))
  .handler(async ({ data, context }) => forbidOr(async () => (await server()).readVault(await adminDb(), { userId: context.userId, filters: data.filters, limit: data.limit, request: await request() })));

/** The chain's checks, the alerts, and the completeness inventory in one read (the read itself is logged as part of the access). */
export const getAuditVaultOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    forbidOr(async () => {
      const s = await server();
      const db = await adminDb();
      await s.requireVaultReader(db, context.userId);
      const req = await request();
      await db.from("audit_log").insert({ actor_id: context.userId, actor_type: await s.vaultRole(db, context.userId), action_type: "audit.vault_accessed", entity_type: "audit_vault_overview", metadata: { via: "app", what: "checks, alerts and inventory", route: "/admin/audit-vault", ip_address: req.ip, user_agent: req.userAgent } });
      const { AUDIT_INVENTORY } = await import("@/lib/audit-inventory");
      return { status: await s.vaultStatus(db, { userId: context.userId }), alerts: (await s.listAlerts(db, { userId: context.userId })).alerts, inventory: AUDIT_INVENTORY };
    }),
  );

export const verifyAuditChainNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) =>
    forbidOr(async () => {
      const s = await server();
      const db = await adminDb();
      await s.requireVaultOfficer(db, context.userId);
      return s.verifyChain(db, { source: "manual", actorId: context.userId });
    }),
  );

export const acknowledgeSecurityAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { alertId: string; note: string }) => ({ alertId: String(input?.alertId ?? "").slice(0, 64), note: String(input?.note ?? "").slice(0, 1000) }))
  .handler(async ({ data, context }) => forbidOr(async () => (await server()).acknowledgeAlert(await adminDb(), { userId: context.userId, alertId: data.alertId, note: data.note, request: await request() })));
