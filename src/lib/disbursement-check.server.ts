/**
 * Disbursement Check — the Zero-Error gate (Prompt 16).
 *
 * Compares the platform's commission figures (the transmitted Prompt 11
 * Source of Truth) line by line against the title/escrow company's reported
 * final numbers. Any difference of even $0.01 on any line FAILS the check;
 * the Closing Ping Saga (Prompt 13, step 3) halts on a failure.
 *
 * Every run — pass or fail — is persisted with full line-item detail and
 * written to audit_log as evidence that the check was performed.
 */

type Db = { from: (t: string) => any };

export type TitleSource = "webhook" | "manual_entry";

export interface CheckLine {
  brokerId: string;
  brokerage: string;
  platformCents: number | null;
  titleCents: number | null;
  deltaCents: number;
  match: boolean;
  kind: "match" | "amount_mismatch" | "missing_in_title" | "unexpected_in_title";
}

export interface CheckDifference {
  kind: string;
  brokerId?: string;
  brokerage?: string;
  platformCents?: number | null;
  titleCents?: number | null;
  deltaCents?: number;
  detail?: string;
}

export interface DisbursementCheckResult {
  status: "pass" | "fail";
  checkId: string | null;
  propertyId: string;
  settlementDocumentId: string;
  sourceOfTruthVersion: number;
  sourceOfTruthHash: string;
  titleSource: TitleSource | null;
  titleReportedAt: string | null;
  lines: CheckLine[];
  platformTotalCents: number;
  titleTotalCents: number | null;
  /** Kinds kept compatible with the Prompt 13 saga record. */
  differences: CheckDifference[];
  report: string;
}

const usd = (cents: number | null) =>
  cents == null ? "—" : (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const signed = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${usd(Math.abs(cents))}`;
const toCents = (amount: number) => Math.round(Number(amount) * 100);

/** The most recent title figures: webhook (funded_and_recorded) or manual entry, whichever is newer. */
export async function latestTitleFigures(db: Db, propertyId: string) {
  const candidates: Array<{ source: TitleSource; at: string; figures: Array<{ payeeReference: string; amount: number }> }> = [];

  const { data: order } = await db.from("title_escrow_orders").select("provider").eq("property_id", propertyId).maybeSingle();
  const { data: events } = await db
    .from("title_escrow_events")
    .select("raw_payload, received_at")
    .eq("property_id", propertyId)
    .eq("milestone", "funded_and_recorded")
    .order("received_at", { ascending: false })
    .limit(1);
  const ev = ((events ?? []) as Array<{ raw_payload: unknown; received_at: string }>)[0];
  if (order && ev) {
    const { getTitleAdapter } = await import("@/lib/title-adapters");
    const parsed = getTitleAdapter(order.provider).parseWebhook(JSON.stringify(ev.raw_payload));
    if (parsed?.commissionDisbursements?.length)
      candidates.push({ source: "webhook", at: ev.received_at, figures: parsed.commissionDisbursements });
  }

  const { data: manual } = await db
    .from("title_reported_figures")
    .select("figures, entered_at")
    .eq("property_id", propertyId)
    .order("entered_at", { ascending: false })
    .limit(1);
  const m = ((manual ?? []) as Array<{ figures: Array<{ payeeReference: string; amount: number }>; entered_at: string }>)[0];
  if (m) candidates.push({ source: "manual_entry", at: m.entered_at, figures: m.figures });

  candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return candidates[0] ?? null;
}

/** Record the title company's final numbers by hand (testing / until a live feed exists). */
export async function enterTitleFigures(
  db: Db,
  actorId: string,
  propertyId: string,
  figures: Array<{ payeeReference: string; amount: number }>,
  note: string | null,
) {
  for (const f of figures)
    if (!f.payeeReference || !Number.isFinite(Number(f.amount)) || Number(f.amount) < 0)
      throw new Error("Every line needs a payee and a non-negative amount");
  const { data, error } = await db
    .from("title_reported_figures")
    .insert({ property_id: propertyId, figures, note, entered_by: actorId, entered_at: new Date().toISOString() })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  await db.from("audit_log").insert({
    actor_id: actorId,
    actor_type: "admin",
    action_type: "disbursement_check.title_figures_entered",
    entity_type: "property",
    entity_id: propertyId,
    metadata: { figures, note, title_figures_id: data?.id ?? null },
  });
  return { id: data?.id as string };
}

export async function runDisbursementCheck(
  db: Db,
  propertyId: string,
  opts: { triggeredBy?: string; actorId?: string | null } = {},
): Promise<DisbursementCheckResult> {
  const { latestSourceOfTruth } = await import("@/lib/settlement.server");
  const sot = await latestSourceOfTruth(db, propertyId);
  if (!sot) throw new Error("No transmitted Source of Truth for this property — generate it (Prompt 11) first.");
  const payees = sot.structured.payees;
  const title = await latestTitleFigures(db, propertyId);
  const titleLines = (title?.figures ?? []).map((f) => ({ brokerId: f.payeeReference, cents: toCents(f.amount) }));

  const lines: CheckLine[] = payees.map((p) => {
    const t = titleLines.find((x) => x.brokerId === p.brokerId);
    if (!t) return { brokerId: p.brokerId, brokerage: p.brokerageName, platformCents: p.amountCents, titleCents: null, deltaCents: -p.amountCents, match: false, kind: "missing_in_title" };
    const delta = t.cents - p.amountCents;
    return { brokerId: p.brokerId, brokerage: p.brokerageName, platformCents: p.amountCents, titleCents: t.cents, deltaCents: delta, match: delta === 0, kind: delta === 0 ? "match" : "amount_mismatch" };
  });
  for (const t of titleLines)
    if (!payees.some((p) => p.brokerId === t.brokerId))
      lines.push({ brokerId: t.brokerId, brokerage: "Unknown payee", platformCents: null, titleCents: t.cents, deltaCents: t.cents, match: false, kind: "unexpected_in_title" });

  const platformTotal = sot.structured.totals.commissionCents;
  const titleTotal = titleLines.length ? titleLines.reduce((a, t) => a + t.cents, 0) : null;
  const differences: CheckDifference[] = [];
  if (!title) differences.push({ kind: "no_title_figures", detail: "The title company hasn't reported final commission figures." });
  for (const l of lines.filter((x) => !x.match))
    differences.push({ kind: l.kind, brokerId: l.brokerId, brokerage: l.brokerage, platformCents: l.platformCents, titleCents: l.titleCents, deltaCents: l.deltaCents });
  if (titleTotal != null && titleTotal !== platformTotal)
    differences.push({ kind: "total_mismatch", platformCents: platformTotal, titleCents: titleTotal, deltaCents: titleTotal - platformTotal });
  const status: "pass" | "fail" = differences.length ? "fail" : "pass";

  const report = [
    `DISBURSEMENT CHECK — ${status === "pass" ? "PASSED" : "FAILED"}`,
    `Source of Truth v${sot.version} (${sot.content_hash}) vs title figures from ${title ? `${title.source.replace("_", " ")} at ${title.at}` : "— none reported —"}`,
    "",
    ...lines.map(
      (l, i) =>
        `${i + 1}. ${l.brokerage} [${l.brokerId}] — platform ${usd(l.platformCents)} · title ${usd(l.titleCents)} · ${
          l.match ? "MATCH" : `MISMATCH ${signed(l.deltaCents)} (${l.kind.replace(/_/g, " ")})`
        }`,
    ),
    "",
    `Total — platform ${usd(platformTotal)} · title ${usd(titleTotal)}${titleTotal != null && titleTotal !== platformTotal ? ` · MISMATCH ${signed(titleTotal - platformTotal)}` : ""}`,
    status === "fail" ? "The wire must not proceed until every line is reconciled to the cent." : "Every line matches to the cent.",
  ].join("\n");

  const { data: row } = await db
    .from("disbursement_checks")
    .insert({
      property_id: propertyId,
      settlement_document_id: sot.id,
      status,
      platform_total_cents: platformTotal,
      title_total_cents: titleTotal,
      differences,
      lines,
      title_source: title?.source ?? null,
      report,
      source_of_truth_hash: sot.content_hash,
      triggered_by: opts.triggeredBy ?? "manual",
      checked_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();

  // The evidence record: every line, both sides, the verdict.
  await db.from("audit_log").insert({
    actor_id: opts.actorId ?? null,
    actor_type: opts.actorId ? "admin" : "system",
    action_type: `disbursement_check.${status === "pass" ? "passed" : "failed"}`,
    entity_type: "property",
    entity_id: propertyId,
    metadata: {
      check_id: row?.id ?? null,
      settlement_document_id: sot.id,
      source_of_truth_version: sot.version,
      source_of_truth_hash: sot.content_hash,
      title_source: title?.source ?? null,
      title_reported_at: title?.at ?? null,
      triggered_by: opts.triggeredBy ?? "manual",
      lines,
      platform_total_cents: platformTotal,
      title_total_cents: titleTotal,
      differences,
    },
  });

  return {
    status,
    checkId: row?.id ?? null,
    propertyId,
    settlementDocumentId: sot.id,
    sourceOfTruthVersion: sot.version,
    sourceOfTruthHash: sot.content_hash,
    titleSource: title?.source ?? null,
    titleReportedAt: title?.at ?? null,
    lines,
    platformTotalCents: platformTotal,
    titleTotalCents: titleTotal,
    differences,
    report,
  };
}
