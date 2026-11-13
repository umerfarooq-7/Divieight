import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { DocumentsRole } from "@/lib/document-access.server";

/** Callable surface for the document-access stages: the Pre-Payment Review acknowledgment, executed-copy snapshots, and Member Documents. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function request() {
  try {
    const { getRequest, getRequestIP } = await import("@tanstack/react-start/server");
    return { ip: getRequestIP({ xForwardedFor: true }) ?? null, userAgent: getRequest().headers.get("user-agent") };
  } catch {
    return { ip: null, userAgent: null };
  }
}

const str = (v: unknown, label: string, max: number) => {
  const t = String(v ?? "").trim();
  if (!t) throw new Error(`Missing ${label}`);
  return t.slice(0, max);
};
const role = (v: unknown): DocumentsRole => {
  if (v !== "buyer" && v !== "seller" && v !== "professional") throw new Error("Unknown role");
  return v;
};

export const getPraReviewState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string }) => ({ actingMemberId: str(input?.actingMemberId, "member", 64) }))
  .handler(async ({ data, context }) => (await import("@/lib/document-access.server")).praReviewState(await adminDb(), { userId: context.userId, actingMemberId: data.actingMemberId }));

export const acknowledgePraReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { actingMemberId: string; documentVersion: string; documentHash: string; reachedEnd: boolean }) => ({
    actingMemberId: str(input?.actingMemberId, "member", 64),
    documentVersion: str(input?.documentVersion, "version", 40),
    documentHash: str(input?.documentHash, "document hash", 200),
    reachedEnd: input?.reachedEnd === true,
  }))
  .handler(async ({ data, context }) =>
    (await import("@/lib/document-access.server")).recordPraReviewAck(await adminDb(), { userId: context.userId, ...data, request: await request() }),
  );

/** Called by the signing screen right after the signature succeeds: keeps the exact executed text. Accepted only if it hashes to the signed hash. */
export const keepExecutedText = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { documentType: string; documentVersion: string; text: string }) => {
    if (input?.documentType !== "PRA" && input?.documentType !== "listing_agreement") throw new Error("Unknown document");
    return { documentType: input.documentType as "PRA" | "listing_agreement", documentVersion: str(input.documentVersion, "version", 40), text: String(input.text ?? "") };
  })
  .handler(async ({ data, context }) => (await import("@/lib/document-access.server")).saveExecutedSnapshot(await adminDb(), { userId: context.userId, ...data }));

export const listMyExecutedDocuments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { role: string }) => ({ role: role(input?.role) }))
  .handler(async ({ data, context }) => ({ documents: await (await import("@/lib/document-access.server")).listExecutedDocuments(await adminDb(), { userId: context.userId, role: data.role }) }));

/** The executed copy as text (the browser turns it into the PDF), with its hash and Audit Vault reference. Never a rebuild from a template. */
export const getMyExecutedCopy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { role: string; id: string }) => ({ role: role(input?.role), id: str(input?.id, "document", 120) }))
  .handler(async ({ data, context }) => {
    const db = await adminDb();
    const copy = await (await import("@/lib/document-access.server")).executedCopy(db, { userId: context.userId, role: data.role, id: data.id });
    await db.from("audit_log").insert({
      actor_id: context.userId,
      actor_type: data.role,
      action_type: "document.executed_copy_downloaded",
      entity_type: "executed_document",
      entity_id: copy.doc.auditRef?.id ?? null,
      metadata: { document_id: data.id, document_hash: copy.doc.hash, version: copy.doc.version, text_sha256: copy.textSha256 },
    });
    return copy;
  });
