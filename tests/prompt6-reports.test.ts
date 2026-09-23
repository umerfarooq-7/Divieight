/**
 * Prompt 6 — Appraisal & Inspection Report Delivery.
 */
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { detectReportFlags, appraisalShortfallPercent } from "@/lib/reports";
import {
  deliverPropertyReport,
  listBuyerReports,
  listAgentReports,
  annotateReport,
} from "@/lib/reports.functions";
import { createAuthorizationRequest, getBuyerAuthorization } from "@/lib/authorization.functions";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;

const INSPECTION = {
  propertyId: IDS.property,
  reportType: "inspection" as const,
  title: "Home inspection — Acme",
  vendorName: "Acme Inspections",
  reportDate: "2026-09-20",
  fileUrl: "u-admin/prop-1/report-inspection-1.pdf",
  contentHash: "djb2_abc_100",
  reportText: "Roof in fair condition. Minor settling noted.",
};

const APPRAISAL = {
  propertyId: IDS.property,
  reportType: "appraisal" as const,
  title: "Appraisal — Summit Valuation",
  fileUrl: "u-admin/prop-1/report-appraisal-1.pdf",
  contentHash: "djb2_def_200",
  contractPrice: 2_500_000,
  appraisedValue: 2_300_000,
};

async function deliverAs(input: Record<string, unknown>) {
  as(USERS.admin);
  return deliverPropertyReport({ data: input as any });
}

// Language that would amount to the Manager interpreting or advising.
const INTERPRETIVE = /we recommend|you should|serious|significant concern|we advise|is a problem|red flag|deal[- ]breaker|walk away|renegotiat/i;

describe("Material-Adverse-Finding filter", () => {
  it("flags an appraisal materially below contract with the percent only", () => {
    expect(appraisalShortfallPercent(2_500_000, 2_300_000)).toBeCloseTo(8, 5);
    const flags = detectReportFlags({ reportType: "appraisal", contractPrice: 2_500_000, appraisedValue: 2_300_000 });
    expect(flags).toEqual([
      { code: "appraisal_below_contract", message: "Appraised value is below the contract price by 8%." },
    ]);
  });

  it("does not flag at/above contract or under the threshold", () => {
    expect(detectReportFlags({ reportType: "appraisal", contractPrice: 100, appraisedValue: 100 })).toEqual([]);
    expect(detectReportFlags({ reportType: "appraisal", contractPrice: 100, appraisedValue: 120 })).toEqual([]);
    expect(detectReportFlags({ reportType: "appraisal", contractPrice: 1000, appraisedValue: 990 })).toEqual([]); // 1% < 2%
    expect(
      detectReportFlags({ reportType: "appraisal", contractPrice: 1000, appraisedValue: 990, shortfallThresholdPercent: 0.5 }),
    ).toHaveLength(1);
  });

  it("flags explicit hazard/structural phrases by quoting them, case-insensitively", () => {
    const flags = detectReportFlags({
      reportType: "inspection",
      reportText: "Section 4: STRUCTURAL   DEFICIENCY at the north wall.\nAlso a hazardous condition near the panel. Asbestos suspected.",
    });
    expect(flags.map((f) => f.message)).toEqual([
      'Report text contains the phrase "structural deficiency".',
      'Report text contains the phrase "hazardous condition".',
      'Report text contains the phrase "asbestos".',
    ]);
    for (const f of flags) expect(f.message).not.toMatch(INTERPRETIVE);
  });

  it("clean text raises nothing", () => {
    expect(detectReportFlags({ reportType: "inspection", reportText: INSPECTION.reportText })).toEqual([]);
  });
});

describe("Prompt 6 — delivery", () => {
  it("only an admin can record receipt", async () => {
    seedPod(db());
    as(USERS.b1);
    await expect(deliverPropertyReport({ data: INSPECTION as any })).rejects.toThrow("Not authorized");
  });

  it("appraisals require the appraised value", async () => {
    seedPod(db());
    await expect(deliverAs({ ...APPRAISAL, appraisedValue: null })).rejects.toThrow("appraised value");
  });

  it("stores in the Data Room AND the DD Inventory as Required, links both, and audits every step", async () => {
    seedPod(db());
    const r = await deliverAs(INSPECTION);

    const vdr = db().table("property_documents");
    expect(vdr).toHaveLength(1);
    expect(vdr[0]).toMatchObject({ document_type: "inspection", file_url: INSPECTION.fileUrl });

    const dd = db().table("due_diligence_inventory");
    expect(dd).toHaveLength(1);
    expect(dd[0]).toMatchObject({
      category: "inspection",
      required: true,
      is_governing_instrument: false,
      content_hash: INSPECTION.contentHash,
      file_url: INSPECTION.fileUrl,
    });

    const rep = db().table("property_reports")[0];
    expect(rep).toMatchObject({ data_room_document_id: vdr[0].id, diligence_document_id: dd[0].id, flags: [] });
    expect(r.flags).toEqual([]);

    for (const action of ["report.received", "report.stored", "report.delivered", "report.notifications_sent", "diligence.document_placed"])
      expect(db().audits(action)).toHaveLength(1);
    expect(db().audits("report.flagged")).toHaveLength(0);
  });

  it("notifies every reserved Buyer Account and their Resident Agent once (in-app); no priority when unflagged", async () => {
    seedPod(db());
    const r = await deliverAs(INSPECTION);
    expect(r).toMatchObject({ buyerNotices: 2, agentNotices: 1 });
    expect(db().notificationsFor(USERS.b1)).toHaveLength(1);
    expect(db().notificationsFor(USERS.b2)).toHaveLength(1);
    expect(db().notificationsFor(USERS.ra)).toHaveLength(1); // both buyers share RA → once
    expect(db().notificationsFor(USERS.b3)).toHaveLength(0); // not reserved
    expect(db().table("notifications").some((n) => n.type === "report_flag")).toBe(false);
  });

  it("a flagged appraisal sends a separate PRIORITY notice, non-substantive, and audits the flag", async () => {
    seedPod(db());
    const r = await deliverAs(APPRAISAL);
    expect(r.flags).toHaveLength(1);
    const priority = db().table("notifications").filter((n) => n.type === "report_flag");
    expect(priority.map((n) => n.seller_id).sort()).toEqual([USERS.b1, USERS.b2, USERS.ra].sort());
    for (const n of priority) {
      expect(n.message).toMatch(/^PRIORITY — /);
      expect(n.message).toContain("below the contract price by 8%");
      expect(n.message).toContain("not an interpretation");
    }
    expect(db().audits("report.flagged")[0].metadata.flags[0].code).toBe("appraisal_below_contract");
  });

  it("the shortfall threshold comes from platform_settings", async () => {
    seedPod(db());
    db().seed("platform_settings", [{ key: "report_flags", value: { appraisal_shortfall_percent: 10 } }]);
    const r = await deliverAs(APPRAISAL); // 8% < 10%
    expect(r.flags).toEqual([]);
  });

  it("the new Required document blocks Buyer-Authorization until acknowledged (Prompt 2 link)", async () => {
    seedPod(db());
    as(USERS.admin);
    const { id } = await createAuthorizationRequest({
      data: { propertyId: IDS.property, buyerAccountId: IDS.b1, actionType: "contingency_waiver", headline: "Waive", terms: {} },
    });
    as(USERS.b1);
    expect((await getBuyerAuthorization({ data: { id } })).allowed).toBe(true);
    await deliverAs(INSPECTION);
    as(USERS.b1);
    const view = await getBuyerAuthorization({ data: { id } });
    expect(view.allowed).toBe(false);
    expect(view.gateBlocker).toBe("both");
  });

  it("a revised report supersedes the prior Required document and forces re-acknowledgment", async () => {
    seedPod(db());
    const first = await deliverAs(INSPECTION);
    await deliverAs({ ...INSPECTION, title: "Home inspection — Acme (rev 2)", contentHash: "djb2_new_101", fileUrl: "x/rev2.pdf", supersedesReportId: first.id });
    const dd = db().table("due_diligence_inventory");
    expect(dd).toHaveLength(2);
    expect(dd[0].superseded_by).toBe(dd[1].id);
    expect(db().audits("diligence.reacknowledgment_required")).toHaveLength(1);
    expect(db().notificationsFor(USERS.b1).at(-1)!.message).toMatch(/^A revised inspection report/);

    as(USERS.b1);
    const { reports } = await listBuyerReports();
    expect(reports.find((r) => r.id === first.id)!.superseded).toBe(true);
  });

  it("no delivery copy interprets or advises (Manager's Restraint)", async () => {
    seedPod(db());
    await deliverAs(APPRAISAL);
    await deliverAs({ ...INSPECTION, reportText: "structural deficiency; hazardous condition" });
    for (const n of db().table("notifications")) expect(n.message).not.toMatch(INTERPRETIVE);
    expect(db().table("notifications")[0].message).toContain("does not interpret");
  });
});

describe("Prompt 6 — portal access and Resident Agent annotations", () => {
  it("reserved buyers see the unredacted report with a file link; non-reserved buyers see nothing", async () => {
    seedPod(db());
    await deliverAs(INSPECTION);
    as(USERS.b1);
    const mine = await listBuyerReports();
    expect(mine.reports).toHaveLength(1);
    expect(mine.reports[0]!.signed_url).toContain(INSPECTION.fileUrl);
    as(USERS.b3);
    expect((await listBuyerReports()).reports).toHaveLength(0);
  });

  it("the tethered agent sees each buyer's report and can annotate; the note reaches only that buyer", async () => {
    seedPod(db());
    const rep = await deliverAs(INSPECTION);
    as(USERS.ra);
    const { rows } = await listAgentReports();
    expect(rows.map((r) => r.buyerAccountId).sort()).toEqual([IDS.b1, IDS.b2].sort());

    await annotateReport({ data: { reportId: rep.id, buyerAccountId: IDS.b1, note: "Let's discuss the roof on Monday." } });
    expect(db().audits("report.annotated")).toHaveLength(1);

    as(USERS.b1);
    const b1 = await listBuyerReports();
    expect(b1.reports[0]!.annotations.map((a) => a.note)).toEqual(["Let's discuss the roof on Monday."]);
    expect(b1.reports[0]!.annotations[0]!.agent_name).toBe("Rita Resident");
    as(USERS.b2);
    expect((await listBuyerReports()).reports[0]!.annotations).toHaveLength(0);
  });

  it("only the buyer's tethered Resident Agent may annotate — not another agent, the HLA, or the admin", async () => {
    seedPod(db());
    const rep = await deliverAs(INSPECTION);
    for (const user of [USERS.ra2, USERS.hla]) {
      as(user);
      await expect(
        annotateReport({ data: { reportId: rep.id, buyerAccountId: IDS.b1, note: "x" } }),
      ).rejects.toThrow("your own tethered buyers");
    }
    as(USERS.admin);
    await expect(
      annotateReport({ data: { reportId: rep.id, buyerAccountId: IDS.b1, note: "x" } }),
    ).rejects.toThrow("Only a Resident Agent");
  });
});
