/**
 * The Final Acknowledgment Posture Record as a PDF (the same writer as the statements: Helvetica, never under 11 pt). Drawn only from the stored record,
 * so the same record always gives the same document.
 */
import { Doc, emitPdf } from "@/lib/statement-pdf";
import type { PostureAck } from "@/lib/ack-gate";

const when = (iso: string) => iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");

export function renderPosturePdf(data: Record<string, any>, version: number, hash: string): Uint8Array<ArrayBuffer> {
  const doc = new Doc();
  doc.text("Final Acknowledgment Posture Record", { size: 18, bold: true });
  doc.text(String(data["property"]?.address ?? "Property"), { size: 13, bold: true });
  doc.text(`Version ${version} · made ${when(String(data["generated_at"]))}`);
  doc.text(`Record hash (sha256): ${hash}`);
  const s = data["summary"] as Record<string, any>;
  doc.text(`${s["buyer_accounts"]} buyer account(s) · ${s["members"]} member(s) · ${s["agents"]} agent(s) · ${s["required_documents"]} Required document(s) · ${s["acknowledgments"]} acknowledgment(s). ${s["complete"] ? "Every acknowledgment is on record." : "INCOMPLETE."}`, { bold: true });

  doc.heading("Required documents");
  for (const d of data["documents"] as Array<Record<string, any>>) {
    doc.text(`${d["title"]}, version ${d["version"]}${d["material_report_flags"] ? ` (material report: ${d["material_report_flags"]} flagged finding(s))` : ""}`, { bold: true });
    doc.text(`Content hash ${d["content_hash"]} · placed ${when(String(d["placed_at"]))}`, { x: 66 });
    for (const e of d["earlier_versions"] as Array<Record<string, any>>) doc.text(`Earlier: version ${e["version"]} (${e["content_hash"]}); acknowledgments of it stay on record.`, { x: 66 });
  }

  const ack = (a: PostureAck) => {
    doc.text(`${a.title} v${a.version}${a.current ? "" : " (earlier version)"}: ${when(a.acknowledged_at)} · ${a.method === "authority" ? "by documented authority" : "typed signature"}${a.signed_name ? ` (${a.signed_name})` : ""}`, { x: 78 });
    doc.text(`IP ${a.ip_address ?? "not recorded"} · device ${a.device_fingerprint ?? "not recorded"} · hash ${a.content_hash}`, { x: 90 });
  };
  for (const acct of data["buyer_accounts"] as Array<Record<string, any>>) {
    doc.heading(`Buyer Account ${String(acct["buyer_account_id"]).slice(0, 8)}`, 13);
    for (const m of acct["members"] as Array<Record<string, any>>) {
      doc.text(`Member: ${m["name"]}`, { bold: true });
      for (const a of m["acknowledgments"] as PostureAck[]) ack(a);
      for (const x of m["missing"] as Array<Record<string, any>>) doc.text(`MISSING: ${x["title"]} v${x["version"]}`, { x: 78, bold: true });
    }
    const ag = acct["agent"] as Record<string, any> | null;
    if (ag) {
      doc.text(`Resident Agent: ${ag["name"]}`, { bold: true });
      for (const a of ag["acknowledgments"] as PostureAck[]) ack(a);
      for (const x of ag["missing"] as Array<Record<string, any>>) doc.text(`MISSING: ${x["title"]} v${x["version"]}`, { x: 78, bold: true });
    } else doc.text("Resident Agent: none tethered", { bold: true });
  }

  doc.heading("Late-arriving documents (gate re-triggers)");
  const rt = data["retriggers"] as Array<Record<string, any>>;
  if (rt.length === 0) doc.text("None: every Required document was on file before acknowledgments began.");
  for (const r of rt) doc.text(`${when(String(r["triggered_at"]))}: ${r["title"]} v${r["version"]} (${r["kind"] === "new_version" ? "a new version replaced an earlier one" : "a new Required document was added"})${r["after_acknowledgments"] ? ", after acknowledgments of other documents" : ""}. The gate closed again until each member and agent acknowledged it.`);
  return emitPdf(doc, "Final Acknowledgment Posture Record");
}
