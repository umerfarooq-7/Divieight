import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabase } from "@/integrations/supabase/client";
import { buildGateState, gateClear, gatingDocuments } from "@/lib/due-diligence";
import { adminRecipients, deliver } from "@/lib/authorization.notify.server";
import { auditIp } from "@/lib/request-ip.server";
import {
  AUTHORIZATION_ACTIONS,
  AUTHORIZATION_ACTION_LABELS,
  CONSEQUENCE_TEXT,
  MARKET_DRIVEN_ACTIONS,
  authorizationState,
  dispositionFor,
  type AuthorizationAction,
  type AuthorizationMember,
  type AuthorizationRequestRow,
  type AuthorizationResponseRow,
  type AuthorizationTerms,
  type RecommendationKind,
} from "@/lib/authorization";
import {
  commissionItemState,
  commissionStatement,
  instrumentHash,
  perShareBasisCents,
  perShareCommissionCents,
  type CommissionFundingSource,
  type CommissionItemRow,
  type CommissionResponseRow,
} from "@/lib/commission-item";

/**
 * Buyer-Authorization Workflow — server side.
 *
 * The Due Diligence Acknowledgment Gate (Prompt 2) is a precondition here: this
 * module only ever READS `gateClear()`, it never writes acknowledgments.
 */

type Db = { from: (t: string) => any };

export type DiligenceGateBlocker = "buyer" | "agent" | "both" | null;

interface DiligenceGateStatus {
  clear: boolean;
  blocker: DiligenceGateBlocker;
}

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

export async function audit(
  db: Db,
  row: {
    actorId: string | null;
    actorType: string;
    actionType: string;
    entityId?: string | null;
    entityType?: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db.from("audit_log").insert({
    actor_id: row.actorId,
    actor_type: row.actorType,
    action_type: row.actionType,
    entity_type: row.entityType ?? "authorization_request",
    entity_id: row.entityId ?? null,
    metadata: row.metadata ?? {},
  });
}

/** Required-document acknowledgment status for one buyer account + property. */
export async function diligenceGateStatus(
  db: Db,
  propertyId: string,
  buyerAccountId: string,
): Promise<DiligenceGateStatus> {
  const { data: docs } = await db
    .from("due_diligence_inventory")
    .select("*")
    .eq("property_id", propertyId);
  const documents = (docs ?? []) as any[];
  if (documents.length === 0) return { clear: true, blocker: null };
  const { data: acks } = await db
    .from("due_diligence_acknowledgments")
    .select(
      "id, document_id, actor_role, account_member_id, agent_id, signed_name, content_hash, acknowledged_at, independent_review_notice_shown_at",
    )
    .eq("buyer_account_id", buyerAccountId)
    .in(
      "document_id",
      documents.map((d) => d.id),
    );
  const { data: members } = await db
    .from("account_members")
    .select("id, full_name, role")
    .eq("buyer_account_id", buyerAccountId);
  const memberRows = (members ?? []) as Array<{ id: string }>;
  const { currentAgentAcks } = await import("@/lib/due-diligence.functions");
  const liveAcks = await currentAgentAcks(db, buyerAccountId, (acks ?? []) as any[]);
  const states = buildGateState(documents as any, liveAcks as any, memberRows as any);
  const required = gatingDocuments(states);
  const buyerPending = required.some(
    (state) =>
      memberRows.length === 0 || memberRows.some((member) => !state.memberAcked.includes(member.id)),
  );
  const agentPending = required.some((state) => !state.agentAcked);

  return {
    clear: gateClear(states),
    blocker: buyerPending ? (agentPending ? "both" : "buyer") : agentPending ? "agent" : null,
  };
}

export async function diligenceGateClear(
  db: Db,
  propertyId: string,
  buyerAccountId: string,
): Promise<boolean> {
  return (await diligenceGateStatus(db, propertyId, buyerAccountId)).clear;
}

async function buyerFor(db: Db, authUserId: string) {
  const { data } = await db
    .from("buyer_accounts")
    .select("id, auth_user_id, email, tethered_resident_agent_id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  return data as
    | { id: string; auth_user_id: string; email: string; tethered_resident_agent_id: string | null }
    | null;
}

async function agentFor(db: Db, authUserId: string) {
  const { data } = await db
    .from("agents")
    .select("id, auth_user_id, full_name, email")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  return data as
    | { id: string; auth_user_id: string; full_name: string; email: string | null }
    | null;
}

async function isAdmin(userId: string) {
  const { data } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  return Boolean(data);
}

async function propertyFor(db: Db, id: string) {
  const { data } = await db
    .from("properties")
    .select("id, address, city, state")
    .eq("id", id)
    .maybeSingle();
  return data as { id: string; address: string; city: string; state: string } | null;
}

function propertyLabel(p: { address: string; city: string; state: string } | null) {
  return p ? `${p.address}, ${p.city}, ${p.state}` : "your subject property";
}

async function loadResponses(db: Db, requestId: string): Promise<AuthorizationResponseRow[]> {
  const { data } = await db
    .from("authorization_responses")
    .select(
      "id, request_id, account_member_id, decision, signed_name, on_behalf_of_member_id, authority_basis, responded_at",
    )
    .eq("request_id", requestId);
  return (data ?? []) as AuthorizationResponseRow[];
}

async function loadMembers(db: Db, buyerAccountId: string): Promise<AuthorizationMember[]> {
  const { data } = await db
    .from("account_members")
    .select("id, full_name, role")
    .eq("buyer_account_id", buyerAccountId);
  return (data ?? []) as AuthorizationMember[];
}

// ---------------------------------------------------------------------------
// Creating a request
// ---------------------------------------------------------------------------

export interface CreateAuthorizationInput {
  propertyId: string;
  buyerAccountId: string;
  actionType: AuthorizationAction;
  headline: string;
  terms: AuthorizationTerms;
  priorRequestId?: string | null;
  /** Explicit market deadline (seller's clock) — otherwise the default window. */
  deadlineAt?: string | null;
}

/** Queue a triggering action for the Buyer Account's express authorization. */
export const createAuthorizationRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CreateAuthorizationInput) => {
    if (!input?.propertyId || !input?.buyerAccountId) throw new Error("Missing target");
    if (!AUTHORIZATION_ACTIONS.includes(input.actionType)) throw new Error("Unknown action");
    if (!input.headline?.trim()) throw new Error("Describe the action");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();

    const { DEFAULT_AUTHORIZATION_SETTINGS, AUTHORIZATION_SETTINGS_KEY } = await import(
      "@/lib/authorization"
    );
    const { data: setting } = await db
      .from("platform_settings")
      .select("value")
      .eq("key", AUTHORIZATION_SETTINGS_KEY)
      .maybeSingle();
    const settings = { ...DEFAULT_AUTHORIZATION_SETTINGS, ...((setting?.value as object) ?? {}) };

    const deadline =
      data.deadlineAt ??
      new Date(Date.now() + settings.default_response_hours * 36e5).toISOString();

    let priorTerms: AuthorizationTerms | null = null;
    if (data.priorRequestId) {
      const { data: prior } = await db
        .from("authorization_requests")
        .select("terms")
        .eq("id", data.priorRequestId)
        .maybeSingle();
      priorTerms = (prior?.terms as AuthorizationTerms) ?? null;
    }

    const { data: buyer } = await db
      .from("buyer_accounts")
      .select("id, auth_user_id, email, tethered_resident_agent_id")
      .eq("id", data.buyerAccountId)
      .maybeSingle();
    if (!buyer) throw new Error("Buyer account not found");

    const { data: created, error } = await db
      .from("authorization_requests")
      .insert({
        property_id: data.propertyId,
        buyer_account_id: data.buyerAccountId,
        action_type: data.actionType,
        headline: data.headline.trim(),
        terms: data.terms ?? {},
        prior_terms: priorTerms,
        prior_request_id: data.priorRequestId ?? null,
        market_driven: MARKET_DRIVEN_ACTIONS.includes(data.actionType),
        deadline_at: deadline,
        consequence_text: CONSEQUENCE_TEXT[data.actionType],
        agent_id: buyer.tethered_resident_agent_id,
        created_by: userId,
      })
      .select("id, deadline_at")
      .maybeSingle();
    if (error) throw new Error(error.message);

    const property = await propertyFor(db, data.propertyId);
    const link = `/buyer/authorizations/${created.id}`;
    const label = AUTHORIZATION_ACTION_LABELS[data.actionType];

    await deliver(
      db,
      { authUserId: buyer.auth_user_id, email: buyer.email },
      {
        subject: `Your authorization is needed — ${label}`,
        message: `${label} is under consideration for ${propertyLabel(property)}. Review the proposed terms and confirm or decline before the deadline. ${CONSEQUENCE_TEXT[data.actionType]}`,
        link,
        requestId: created.id,
      },
    );

    // Parallel notice to the tethered Resident Agent so a recommendation can be attached.
    if (buyer.tethered_resident_agent_id) {
      const { data: agent } = await db
        .from("agents")
        .select("auth_user_id, email")
        .eq("id", buyer.tethered_resident_agent_id)
        .maybeSingle();
      if (agent) {
        await deliver(
          db,
          { authUserId: agent.auth_user_id, email: agent.email },
          {
            subject: `Authorization request — your recommendation is invited`,
            message: `Your buyer has been asked to authorize: ${label} on ${propertyLabel(property)}. You may attach a recommendation, or note that you have none.`,
            link: "/agent/authorizations",
            requestId: created.id,
          },
        );
      }
    }

    await audit(db, {
      actorId: userId,
      actorType: "admin",
      actionType: "authorization.requested",
      entityId: created.id,
      metadata: {
        action: data.actionType,
        buyer_account_id: data.buyerAccountId,
        property_id: data.propertyId,
        deadline_at: created.deadline_at,
        market_driven: MARKET_DRIVEN_ACTIONS.includes(data.actionType),
        has_prior_version: Boolean(priorTerms),
      },
    });

    return { id: created.id as string };
  });

// ---------------------------------------------------------------------------
// Buyer side
// ---------------------------------------------------------------------------

export interface BuyerAuthorizationPayload {
  allowed: boolean;
  /** Set when the Due Diligence Gate must be cleared before this screen shows. */
  gateBlockedPropertyId: string | null;
  gateBlocker: DiligenceGateBlocker;
  buyerAccountId: string | null;
  request: AuthorizationRequestRow | null;
  responses: AuthorizationResponseRow[];
  members: AuthorizationMember[];
  property: { id: string; address: string; city: string; state: string } | null;
  agentName: string | null;
  /** Discrete commission provision proposed by the Heavy Lifting Agent. */
  commissionItem: CommissionItemRow | null;
  commissionResponses: CommissionResponseRow[];
}

export const getBuyerAuthorization = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => {
    if (!input?.id) throw new Error("Missing request");
    return input;
  })
  .handler(async ({ data, context }): Promise<BuyerAuthorizationPayload> => {
    const db = await adminDb();
    const buyer = await buyerFor(db, context.claims?.sub as string);
    const empty: BuyerAuthorizationPayload = {
      allowed: false,
      gateBlockedPropertyId: null,
      gateBlocker: null,
      buyerAccountId: buyer?.id ?? null,
      request: null,
      responses: [],
      members: [],
      property: null,
      agentName: null,
      commissionItem: null,
      commissionResponses: [],
    };
    if (!buyer) return empty;

    const { data: row } = await db
      .from("authorization_requests")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (!row || row.buyer_account_id !== buyer.id) return empty;

    // Precondition: Required document acknowledgments must be current.
    const gate = await diligenceGateStatus(db, row.property_id, buyer.id);
    if (!gate.clear) {
      await audit(db, {
        actorId: context.claims?.sub as string,
        actorType: "buyer",
        actionType: "authorization.gate_blocked",
        entityId: row.id,
        metadata: {
          property_id: row.property_id,
          reason: "diligence_acknowledgments_outstanding",
          blocker: gate.blocker,
        },
      });
      return {
        ...empty,
        allowed: false,
        gateBlockedPropertyId: row.property_id,
        gateBlocker: gate.blocker,
      };
    }

    let agentName: string | null = null;
    if (row.agent_id) {
      const { data: a } = await db
        .from("agents")
        .select("full_name")
        .eq("id", row.agent_id)
        .maybeSingle();
      agentName = a?.full_name ?? null;
    }

    const commissionItem = await loadCommissionItem(db, row.id);
    return {
      allowed: true,
      gateBlockedPropertyId: null,
      gateBlocker: null,
      buyerAccountId: buyer.id,
      request: row as AuthorizationRequestRow,
      responses: await loadResponses(db, row.id),
      members: await loadMembers(db, buyer.id),
      property: await propertyFor(db, row.property_id),
      agentName,
      commissionItem,
      commissionResponses: commissionItem
        ? await loadCommissionResponses(db, commissionItem.id)
        : [],
    };
  });

export const listBuyerAuthorizations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await adminDb();
    const buyer = await buyerFor(db, context.claims?.sub as string);
    if (!buyer)
      return {
        rows: [] as Array<
          AuthorizationRequestRow & {
            propertyLabel: string;
            gateClear: boolean;
            gateBlocker: DiligenceGateBlocker;
          }
        >,
      };
    const { data } = await db
      .from("authorization_requests")
      .select("*")
      .eq("buyer_account_id", buyer.id)
      .order("created_at", { ascending: false });
    const rows = (data ?? []) as AuthorizationRequestRow[];
    const labels = new Map<string, string>();
    const gates = new Map<string, DiligenceGateStatus>();
    for (const id of new Set(rows.map((r) => r.property_id))) {
      labels.set(id, propertyLabel(await propertyFor(db, id)));
      gates.set(id, await diligenceGateStatus(db, id, buyer.id));
    }
    return {
      rows: rows.map((r) => ({
        ...r,
        propertyLabel: labels.get(r.property_id) ?? "",
        gateClear: gates.get(r.property_id)?.clear ?? true,
        gateBlocker: gates.get(r.property_id)?.blocker ?? null,
      })),
    };
  });

export interface RespondInput {
  requestId: string;
  accountMemberId: string;
  decision: "confirmed" | "declined";
  signedName: string;
  secondaryVerificationMethod: string;
  onBehalfOfMemberId?: string | null;
  authorityBasis?: string | null;
  ipAddress?: string | null;
  deviceFingerprint?: string | null;
}

/** A Preferred Member's express confirmation or decline, via secondary verification. */
export const respondToAuthorization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: RespondInput) => {
    if (!input?.requestId || !input?.accountMemberId) throw new Error("Missing request");
    if (input.decision !== "confirmed" && input.decision !== "declined")
      throw new Error("Invalid decision");
    if (!input.signedName?.trim()) throw new Error("Secondary verification is required");
    if (input.onBehalfOfMemberId && !input.authorityBasis?.trim())
      throw new Error("Documented authority is required to respond for another member");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    const db = await adminDb();
    const buyer = await buyerFor(db, userId);
    if (!buyer) throw new Error("No buyer account");

    const { data: row } = await db
      .from("authorization_requests")
      .select("*")
      .eq("id", data.requestId)
      .maybeSingle();
    if (!row || row.buyer_account_id !== buyer.id) throw new Error("Not authorized");
    if (row.status !== "pending") throw new Error("This request is already resolved");

    if (!(await diligenceGateClear(db, row.property_id, buyer.id)))
      throw new Error("Outstanding due-diligence acknowledgments must be completed first");

    const members = await loadMembers(db, buyer.id);
    if (!members.some((m) => m.id === data.accountMemberId))
      throw new Error("Unknown Account Member");

    const { error } = await db.from("authorization_responses").upsert(
      {
        request_id: row.id,
        buyer_account_id: buyer.id,
        account_member_id: data.accountMemberId,
        decision: data.decision,
        signed_name: data.signedName.trim(),
        secondary_verification_method: data.secondaryVerificationMethod,
        on_behalf_of_member_id: data.onBehalfOfMemberId ?? null,
        authority_basis: data.authorityBasis?.trim() ?? null,
        ip_address: auditIp(data.ipAddress),
        device_fingerprint: data.deviceFingerprint ?? null,
        responded_at: new Date().toISOString(),
      },
      { onConflict: "request_id,account_member_id" },
    );
    if (error) throw new Error(error.message);

    await audit(db, {
      actorId: userId,
      actorType: "buyer",
      actionType:
        data.decision === "confirmed"
          ? "authorization.member_confirmed"
          : "authorization.member_declined",
      entityId: row.id,
      metadata: {
        account_member_id: data.accountMemberId,
        on_behalf_of_member_id: data.onBehalfOfMemberId ?? null,
        authority_basis: data.authorityBasis ?? null,
        secondary_verification_method: data.secondaryVerificationMethod,
        signed_name: data.signedName.trim(),
        ip_address: auditIp(data.ipAddress),
      },
    });

    const responses = await loadResponses(db, row.id);
    const state = authorizationState(row as AuthorizationRequestRow, responses, members);
    let disposition = dispositionFor(state);

    // Authorizing the instrument is NOT authorizing the commission provision.
    // While a proposed provision is unauthorized, the instrument does not tender.
    const commissionItem = await loadCommissionItem(db, row.id);
    const commissionPending = Boolean(commissionItem && commissionItem.status !== "authorized");
    if (disposition === "authorized" && commissionPending) disposition = null;

    if (disposition) {
      await db
        .from("authorization_requests")
        .update({ status: disposition, resolved_at: new Date().toISOString() })
        .eq("id", row.id);

      await audit(db, {
        actorId: userId,
        actorType: "buyer",
        actionType:
          disposition === "authorized"
            ? "authorization.granted"
            : "authorization.declined_final",
        entityId: row.id,
        metadata: {
          action: row.action_type,
          confirmed_members: state.confirmed.length,
          declined_members: state.declined.length,
        },
      });

      const property = await propertyFor(db, row.property_id);
      const label = AUTHORIZATION_ACTION_LABELS[row.action_type as AuthorizationAction];
      if (row.agent_id) {
        const { data: agent } = await db
          .from("agents")
          .select("auth_user_id, email")
          .eq("id", row.agent_id)
          .maybeSingle();
        if (agent)
          await deliver(
            db,
            { authUserId: agent.auth_user_id, email: agent.email },
            {
              subject: `Authorization ${disposition} — ${label}`,
              message: `Your buyer's Account has ${disposition === "authorized" ? "expressly authorized" : "declined"} ${label} on ${propertyLabel(property)}.`,
              link: "/agent/authorizations",
              requestId: row.id,
            },
          );
      }
      for (const admin of await adminRecipients(db)) {
        await deliver(db, admin, {
          subject: `Authorization ${disposition}`,
          message: `${label} on ${propertyLabel(property)} was ${disposition} by the Buyer Account.`,
          link: "/admin/authorizations",
          requestId: row.id,
        });
      }
    }

    return { disposition, outstanding: state.outstanding.length, commissionPending };
  });

// ---------------------------------------------------------------------------
// Resident Agent side
// ---------------------------------------------------------------------------

/** True when the gate's only blocker (if any) is the buyer — the agent side is current. */
export function agentSideClear(status: DiligenceGateStatus): boolean {
  return status.blocker !== "agent" && status.blocker !== "both";
}

export type AgentAuthorizationRow = AuthorizationRequestRow & {
  propertyLabel: string;
  agentGateClear: boolean;
  /** True when this agent is the pod's Heavy Lifting Agent for the property. */
  isHla: boolean;
  commissionItem: CommissionItemRow | null;
  commissionConfirmed: number;
  commissionDeclined: number;
  commissionOutstanding: number;
};

export const listAgentAuthorizations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = await adminDb();
    const agent = await agentFor(db, context.claims?.sub as string);
    if (!agent) return { rows: [] as AgentAuthorizationRow[] };

    // Requests where this agent is the tethered Resident Agent…
    const { data: mine } = await db
      .from("authorization_requests")
      .select("*")
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: false });

    // …plus requests on properties where this agent is the pod's Heavy Lifting
    // Agent, since the commission provision is proposed by the HLA.
    const { data: hlaPods } = await db
      .from("pods")
      .select("property_id, hla_status")
      .eq("heavy_lifting_agent_id", agent.id);
    const hlaProperties = ((hlaPods ?? []) as Array<{ property_id: string; hla_status: string }>)
      .filter((p) => p.hla_status === "accepted")
      .map((p) => p.property_id);
    let hlaRows: AuthorizationRequestRow[] = [];
    if (hlaProperties.length > 0) {
      const { data } = await db
        .from("authorization_requests")
        .select("*")
        .in("property_id", hlaProperties)
        .order("created_at", { ascending: false });
      hlaRows = (data ?? []) as AuthorizationRequestRow[];
    }

    const byId = new Map<string, AuthorizationRequestRow>();
    for (const r of [...((mine ?? []) as AuthorizationRequestRow[]), ...hlaRows]) byId.set(r.id, r);
    const rows = [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));

    const labels = new Map<string, string>();
    const gates = new Map<string, boolean>();
    const out: AgentAuthorizationRow[] = [];
    for (const row of rows) {
      const key = `${row.property_id}:${row.buyer_account_id}`;
      if (!gates.has(key)) {
        gates.set(
          key,
          agentSideClear(await diligenceGateStatus(db, row.property_id, row.buyer_account_id)),
        );
      }
      if (!labels.has(row.property_id))
        labels.set(row.property_id, propertyLabel(await propertyFor(db, row.property_id)));

      const commissionItem = await loadCommissionItem(db, row.id);
      const responses = commissionItem ? await loadCommissionResponses(db, commissionItem.id) : [];
      const members = await loadMembers(db, row.buyer_account_id);
      const state = commissionItemState(
        responses,
        members.map((m) => m.id),
      );
      out.push({
        ...row,
        propertyLabel: labels.get(row.property_id) ?? "",
        agentGateClear: gates.get(key) ?? true,
        isHla: hlaProperties.includes(row.property_id),
        commissionItem,
        commissionConfirmed: state.confirmed.length,
        commissionDeclined: state.declined.length,
        commissionOutstanding: commissionItem ? state.outstanding.length : 0,
      });
    }
    return { rows: out };
  });

/** Attach a recommendation — or explicitly note that there is none. */
export const submitAgentRecommendation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { requestId: string; kind: RecommendationKind; text?: string }) => {
    if (!input?.requestId) throw new Error("Missing request");
    if (!["recommend", "recommend_against", "no_recommendation"].includes(input.kind))
      throw new Error("Invalid recommendation");
    return input;
  })
  .handler(async ({ data, context }) => {
    const db = await adminDb();
    const agent = await agentFor(db, context.claims?.sub as string);
    if (!agent) throw new Error("Not authorized");

    const { data: row } = await db
      .from("authorization_requests")
      .select("id, agent_id, buyer_account_id, property_id, action_type, status")
      .eq("id", data.requestId)
      .maybeSingle();
    if (!row || row.agent_id !== agent.id) throw new Error("Not authorized");

    // Precondition: the agent's own Parallel Resident Agent Acknowledgment must be current.
    if (!agentSideClear(await diligenceGateStatus(db, row.property_id, row.buyer_account_id)))
      throw new Error("Review and acknowledge the required documents for this property first");

    await db
      .from("authorization_requests")
      .update({
        recommendation_kind: data.kind,
        recommendation_text: data.text?.trim() || null,
        recommendation_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    await audit(db, {
      actorId: context.claims?.sub as string,
      actorType: "agent",
      actionType: "authorization.agent_recommendation",
      entityId: row.id,
      metadata: { agent_id: agent.id, kind: data.kind, has_text: Boolean(data.text?.trim()) },
    });

    const { data: buyer } = await db
      .from("buyer_accounts")
      .select("auth_user_id, email")
      .eq("id", row.buyer_account_id)
      .maybeSingle();
    if (buyer && row.status === "pending") {
      await deliver(
        db,
        { authUserId: buyer.auth_user_id, email: buyer.email },
        {
          subject: "Your Resident Agent responded to the authorization request",
          message: `Your Resident Agent has recorded their position on ${AUTHORIZATION_ACTION_LABELS[row.action_type as AuthorizationAction]}. It appears alongside the request in your portal.`,
          link: `/buyer/authorizations/${row.id}`,
          requestId: row.id,
        },
      );
    }
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// Admin / Manager side
// ---------------------------------------------------------------------------

export const listAdminAuthorizations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();
    const { data } = await db
      .from("authorization_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    const rows = (data ?? []) as AuthorizationRequestRow[];
    const labels = new Map<string, string>();
    for (const id of new Set(rows.map((r) => r.property_id))) {
      labels.set(id, propertyLabel(await propertyFor(db, id)));
    }
    const out = [] as Array<
      AuthorizationRequestRow & {
        propertyLabel: string;
        buyerEmail: string | null;
        outstanding: number;
        memberCount: number;
        confirmedCount: number;
        declinedCount: number;
        memberResponses: Array<{
          memberId: string;
          name: string;
          decision: "confirmed" | "declined" | null;
          respondedAt: string | null;
          onBehalfOf: string | null;
        }>;
        commissionItem: CommissionItemRow | null;
        commissionMembers: Array<{
          memberId: string;
          name: string;
          decision: "confirmed" | "declined" | null;
          respondedAt: string | null;
        }>;
      }
    >;
    for (const r of rows) {
      const { data: buyer } = await db
        .from("buyer_accounts")
        .select("email")
        .eq("id", r.buyer_account_id)
        .maybeSingle();
      const responses = await loadResponses(db, r.id);
      const members = await loadMembers(db, r.buyer_account_id);
      const state = authorizationState(r, responses, members);
      const nameOf = (id: string) =>
        members.find((m) => m.id === id)?.full_name ?? "Account Member";
      const memberResponses = members.map((m) => {
        const own = responses.find((x) => x.account_member_id === m.id);
        const proxy = responses.find((x) => x.on_behalf_of_member_id === m.id);
        const hit = own ?? proxy;
        return {
          memberId: m.id,
          name: m.full_name ?? "Account Member",
          decision: (hit?.decision as "confirmed" | "declined" | undefined) ?? null,
          respondedAt: hit?.responded_at ?? null,
          onBehalfOf: !own && proxy ? nameOf(proxy.account_member_id) : null,
        };
      });
      const commissionItem = await loadCommissionItem(db, r.id);
      const commissionResponses = commissionItem
        ? await loadCommissionResponses(db, commissionItem.id)
        : [];
      const commissionMembers = members.map((m) => {
        const hit = commissionResponses.find((x) => x.account_member_id === m.id);
        return {
          memberId: m.id,
          name: m.full_name ?? "Account Member",
          decision: (hit?.decision as "confirmed" | "declined" | undefined) ?? null,
          respondedAt: hit?.responded_at ?? null,
        };
      });
      out.push({
        ...r,
        propertyLabel: labels.get(r.property_id) ?? "",
        buyerEmail: buyer?.email ?? null,
        outstanding: state.outstanding.length,
        memberCount: members.length,
        confirmedCount: state.confirmed.length,
        declinedCount: state.declined.length,
        memberResponses,
        commissionItem,
        commissionMembers,
      });
    }
    return { rows: out };
  });


/** Candidate buyer accounts for queueing a request (admin picker). */
export const listAuthorizationTargets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const db = await adminDb();
    const { data } = await db
      .from("pod_reservations")
      .select("buyer_account_id, property_id, status")
      .eq("status", "reserved");
    const seen = new Set<string>();
    const targets: Array<{
      buyerAccountId: string;
      propertyId: string;
      buyerEmail: string | null;
      propertyLabel: string;
      gateClear: boolean;
    }> = [];
    for (const r of (data ?? []) as Array<{ buyer_account_id: string; property_id: string }>) {
      const key = `${r.buyer_account_id}:${r.property_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { data: buyer } = await db
        .from("buyer_accounts")
        .select("email")
        .eq("id", r.buyer_account_id)
        .maybeSingle();
      targets.push({
        buyerAccountId: r.buyer_account_id,
        propertyId: r.property_id,
        buyerEmail: buyer?.email ?? null,
        propertyLabel: propertyLabel(await propertyFor(db, r.property_id)),
        gateClear: await diligenceGateClear(db, r.property_id, r.buyer_account_id),
      });
    }
    return { targets };
  });

export const runAuthorizationEscalation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = context.claims?.sub as string;
    if (!(await isAdmin(userId))) throw new Error("Not authorized");
    const { runAuthorizationEscalationSweep } = await import("@/lib/authorization.server");
    return runAuthorizationEscalationSweep(userId);
  });

// ---------------------------------------------------------------------------
// Itemized commission authorization
//
// A buyer-side commission provision is its own discrete authorization item.
// It is PROPOSED by the Heavy Lifting Agent and reviewed by each Member's
// tethered Resident Agent; the Manager only presents it and, once authorized,
// executes the resulting instrument.
// ---------------------------------------------------------------------------

export async function loadCommissionItem(
  db: Db,
  requestId: string,
): Promise<CommissionItemRow | null> {
  const { data } = await db
    .from("authorization_commission_items")
    .select("*")
    .eq("request_id", requestId)
    .maybeSingle();
  return (data as CommissionItemRow) ?? null;
}

export async function loadCommissionResponses(
  db: Db,
  itemId: string,
): Promise<CommissionResponseRow[]> {
  const { data } = await db
    .from("authorization_commission_responses")
    .select("id, item_id, account_member_id, decision, signed_name, secondary_verification_method, responded_at")
    .eq("item_id", itemId);
  return (data ?? []) as CommissionResponseRow[];
}

/** The pod's Heavy Lifting Agent for a property, if one has accepted. */
async function heavyLiftingAgentId(db: Db, propertyId: string): Promise<string | null> {
  const { data } = await db
    .from("pods")
    .select("heavy_lifting_agent_id, hla_status")
    .eq("property_id", propertyId)
    .maybeSingle();
  if (!data || data.hla_status !== "accepted") return null;
  return (data.heavy_lifting_agent_id as string) ?? null;
}

export interface ProposeCommissionInput {
  requestId: string;
  ratePercent: number;
  fundingSource: CommissionFundingSource;
  provisionText: string;
}

/**
 * The Heavy Lifting Agent proposes (or revises) the commission provision.
 * Nobody else may originate or price it — not the Manager, not the Resident
 * Agent.
 */
export const proposeCommissionItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ProposeCommissionInput) => {
    if (!input?.requestId) throw new Error("Missing request");
    const rate = Number(input.ratePercent);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100)
      throw new Error("Enter the buyer-side commission rate as a percentage");
    if (
      input.fundingSource !== "proceeds_at_closing" &&
      input.fundingSource !== "member_at_closing"
    )
      throw new Error("Choose how the provision is funded");
    return { ...input, ratePercent: rate };
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    const db = await adminDb();
    const agent = await agentFor(db, userId);
    if (!agent) throw new Error("Not authorized");

    const { data: row } = await db
      .from("authorization_requests")
      .select("id, property_id, buyer_account_id, action_type, terms, status")
      .eq("id", data.requestId)
      .maybeSingle();
    if (!row) throw new Error("Request not found");
    if (row.status !== "pending") throw new Error("This request is already resolved");

    const hlaId = await heavyLiftingAgentId(db, row.property_id);
    if (!hlaId || hlaId !== agent.id)
      throw new Error("Only the pod's Heavy Lifting Agent may propose the commission provision");

    const { data: property } = await db
      .from("properties")
      .select("listing_price")
      .eq("id", row.property_id)
      .maybeSingle();
    const sharePrice = perShareBasisCents(property?.listing_price as number | null);
    const perShare = perShareCommissionCents(
      property?.listing_price as number | null,
      data.ratePercent,
    );
    const hash = instrumentHash({
      requestId: row.id,
      terms: (row.terms as Record<string, string>) ?? {},
      ratePercent: data.ratePercent,
      fundingSource: data.fundingSource,
      provisionText: data.provisionText ?? "",
    });

    const existing = await loadCommissionItem(db, row.id);
    const payload = {
      request_id: row.id,
      proposed_by_agent_id: agent.id,
      rate_percent: data.ratePercent,
      funding_source: data.fundingSource,
      provision_text: (data.provisionText ?? "").trim(),
      share_price_cents: sharePrice,
      per_share_amount_cents: perShare,
      instrument_hash: hash,
      status: "proposed",
      updated_at: new Date().toISOString(),
    };

    let itemId = existing?.id ?? null;
    if (existing) {
      // A revised provision reopens the item: prior member acts no longer apply.
      await db.from("authorization_commission_responses").delete().eq("item_id", existing.id);
      const { error } = await db
        .from("authorization_commission_items")
        .update(payload)
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { data: created, error } = await db
        .from("authorization_commission_items")
        .insert(payload)
        .select("id")
        .maybeSingle();
      if (error) throw new Error(error.message);
      itemId = created?.id ?? null;
    }

    await audit(db, {
      actorId: userId,
      actorType: "agent",
      actionType: "authorization.commission_proposed",
      entityId: row.id,
      entityType: "authorization_commission_item",
      metadata: {
        commission_item_id: itemId,
        proposed_by_agent_id: agent.id,
        rate_percent: data.ratePercent,
        funding_source: data.fundingSource,
        per_share_amount_cents: perShare,
        instrument_hash: hash,
        revised: Boolean(existing),
      },
    });

    // Notify the buyer and the tethered Resident Agent — attributed to the HLA.
    const property2 = await propertyFor(db, row.property_id);
    const { data: buyer } = await db
      .from("buyer_accounts")
      .select("auth_user_id, email, tethered_resident_agent_id")
      .eq("id", row.buyer_account_id)
      .maybeSingle();
    if (buyer) {
      await deliver(
        db,
        { authUserId: buyer.auth_user_id, email: buyer.email },
        {
          subject: "A commission provision needs your separate authorization",
          message: `The Heavy Lifting Agent has proposed a buyer-side commission provision for ${propertyLabel(property2)}. It is presented to you as its own authorization item, separate from the instrument itself. Authorizing the instrument does not authorize this provision.`,
          link: `/buyer/authorizations/${row.id}`,
          requestId: row.id,
        },
      );
    }
    if (buyer?.tethered_resident_agent_id) {
      const { data: ra } = await db
        .from("agents")
        .select("auth_user_id, email")
        .eq("id", buyer.tethered_resident_agent_id)
        .maybeSingle();
      if (ra)
        await deliver(
          db,
          { authUserId: ra.auth_user_id, email: ra.email },
          {
            subject: "Commission provision proposed by the Heavy Lifting Agent",
            message: `A buyer-side commission provision proposed by the Heavy Lifting Agent for ${propertyLabel(property2)} is available for your review alongside the authorization request.`,
            link: "/agent/authorizations",
            requestId: row.id,
          },
        );
    }

    return { id: itemId };
  });

export interface CommissionRespondInput {
  requestId: string;
  accountMemberId: string;
  decision: "confirmed" | "declined";
  signedName: string;
  secondaryVerificationMethod: string;
  ipAddress?: string | null;
  deviceFingerprint?: string | null;
}

/**
 * A Preferred Member's separate affirmative act on the commission provision.
 * This is never implied by the instrument authorization.
 */
export const respondToCommissionItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CommissionRespondInput) => {
    if (!input?.requestId || !input?.accountMemberId) throw new Error("Missing request");
    if (input.decision !== "confirmed" && input.decision !== "declined")
      throw new Error("Invalid decision");
    if (!input.signedName?.trim()) throw new Error("Secondary verification is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const userId = context.claims?.sub as string;
    const db = await adminDb();
    const buyer = await buyerFor(db, userId);
    if (!buyer) throw new Error("No buyer account");

    const { data: row } = await db
      .from("authorization_requests")
      .select("*")
      .eq("id", data.requestId)
      .maybeSingle();
    if (!row || row.buyer_account_id !== buyer.id) throw new Error("Not authorized");
    if (row.status !== "pending") throw new Error("This request is already resolved");

    if (!(await diligenceGateClear(db, row.property_id, buyer.id)))
      throw new Error("Outstanding due-diligence acknowledgments must be completed first");

    const item = await loadCommissionItem(db, row.id);
    if (!item) throw new Error("No commission provision is attached to this request");

    const members = await loadMembers(db, buyer.id);
    if (!members.some((m) => m.id === data.accountMemberId))
      throw new Error("Unknown Account Member");

    const presented = commissionStatement(item);

    const { error } = await db.from("authorization_commission_responses").upsert(
      {
        item_id: item.id,
        request_id: row.id,
        buyer_account_id: buyer.id,
        account_member_id: data.accountMemberId,
        decision: data.decision,
        signed_name: data.signedName.trim(),
        secondary_verification_method: data.secondaryVerificationMethod,
        presented_text: presented,
        instrument_hash: item.instrument_hash,
        ip_address: auditIp(data.ipAddress),
        device_fingerprint: data.deviceFingerprint ?? null,
        responded_at: new Date().toISOString(),
      },
      { onConflict: "item_id,account_member_id" },
    );
    if (error) throw new Error(error.message);

    await audit(db, {
      actorId: userId,
      actorType: "buyer",
      actionType:
        data.decision === "confirmed"
          ? "authorization.commission_authorized"
          : "authorization.commission_declined",
      entityId: row.id,
      entityType: "authorization_commission_item",
      metadata: {
        record_type: "itemized_commission_authorization",
        commission_item_id: item.id,
        account_member_id: data.accountMemberId,
        signed_name: data.signedName.trim(),
        secondary_verification_method: data.secondaryVerificationMethod,
        presented_text: presented,
        instrument_hash: item.instrument_hash,
        ip_address: auditIp(data.ipAddress),
        is_default_under_pra_section_8: false,
      },
    });

    const responses = await loadCommissionResponses(db, item.id);
    const state = commissionItemState(
      responses,
      members.map((m) => m.id),
    );
    const property = await propertyFor(db, row.property_id);

    if (state.anyDeclined) {
      await db
        .from("authorization_commission_items")
        .update({ status: "declined", updated_at: new Date().toISOString() })
        .eq("id", item.id);

      // The instrument is NOT tendered. Route the matter back to the Member's
      // Resident Agent and to the Heavy Lifting Agent for resolution.
      const routeTo: Array<{ authUserId: string; email: string | null }> = [];
      if (row.agent_id) {
        const { data: ra } = await db
          .from("agents")
          .select("auth_user_id, email")
          .eq("id", row.agent_id)
          .maybeSingle();
        if (ra) routeTo.push({ authUserId: ra.auth_user_id, email: ra.email });
      }
      const hlaId = await heavyLiftingAgentId(db, row.property_id);
      if (hlaId) {
        const { data: hla } = await db
          .from("agents")
          .select("auth_user_id, email")
          .eq("id", hlaId)
          .maybeSingle();
        if (hla) routeTo.push({ authUserId: hla.auth_user_id, email: hla.email });
      }
      for (const who of routeTo) {
        await deliver(db, who, {
          subject: "Commission provision declined — resolution needed",
          message: `A Preferred Member has declined the buyer-side commission provision on ${propertyLabel(property)}. The instrument will not be tendered. This declination is explicitly NOT a Default under Section 8 of the Priority Reservation Agreement; it returns to the Resident Agent and the Heavy Lifting Agent for resolution.`,
          link: "/agent/authorizations",
          requestId: row.id,
        });
      }
      return { itemStatus: "declined" as const, outstanding: state.outstanding.length };
    }

    if (state.complete) {
      await db
        .from("authorization_commission_items")
        .update({ status: "authorized", updated_at: new Date().toISOString() })
        .eq("id", item.id);

      // If the instrument itself is already fully authorized, it can now resolve.
      const instrumentState = authorizationState(
        row as AuthorizationRequestRow,
        await loadResponses(db, row.id),
        members,
      );
      if (dispositionFor(instrumentState) === "authorized") {
        await db
          .from("authorization_requests")
          .update({ status: "authorized", resolved_at: new Date().toISOString() })
          .eq("id", row.id);
        await audit(db, {
          actorId: userId,
          actorType: "buyer",
          actionType: "authorization.granted",
          entityId: row.id,
          metadata: {
            action: row.action_type,
            commission_item_authorized: true,
          },
        });
      }
      return { itemStatus: "authorized" as const, outstanding: 0 };
    }

    return { itemStatus: "proposed" as const, outstanding: state.outstanding.length };
  });
