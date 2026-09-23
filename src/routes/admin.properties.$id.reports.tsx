import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { hashFile } from "@/lib/due-diligence";
import { extractPdfText } from "@/lib/pdf-text";
import {
  DELIVERY_NOTICE,
  REPORT_TYPE_LABELS,
  detectReportFlags,
  type ReportType,
} from "@/lib/reports";
import {
  deliverPropertyReport,
  listPropertyReports,
  type ReportView,
} from "@/lib/reports.functions";
import { ReportCard } from "@/components/ReportCard";

export const Route = createFileRoute("/admin/properties/$id/reports")({
  head: () => ({
    meta: [
      { title: "Appraisal & inspection reports — divieight admin" },
      {
        name: "description",
        content: "Record receipt of appraisal and inspection reports and deliver them to the Buyer Group.",
      },
      { property: "og:title", content: "Appraisal & inspection reports — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminPropertyReports,
});

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPTED = ["application/pdf", "image/jpeg", "image/png"];

function AdminPropertyReports() {
  const { id } = Route.useParams();
  const list = useServerFn(listPropertyReports);
  const deliverFn = useServerFn(deliverPropertyReport);

  const [label, setLabel] = useState("");
  const [reports, setReports] = useState<ReportView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [reportType, setReportType] = useState<ReportType>("inspection");
  const [title, setTitle] = useState("");
  const [vendor, setVendor] = useState("");
  const [reportDate, setReportDate] = useState("");
  const [contractPrice, setContractPrice] = useState("");
  const [appraisedValue, setAppraisedValue] = useState("");
  const [reportText, setReportText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [supersedes, setSupersedes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await list({ data: { propertyId: id } });
      setReports(res.reports);
      if (res.property) {
        setLabel(`${res.property.address}, ${res.property.city}, ${res.property.state}`);
        setContractPrice((prev) => prev || (res.property!.listing_price ? String(res.property!.listing_price) : ""));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load reports");
    } finally {
      setLoading(false);
    }
  }, [list, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function pickFile(next: File | null) {
    setFile(next);
    if (!next) return;
    if (!title.trim()) setTitle(next.name.replace(/\.[^.]+$/, ""));
    if (next.type === "application/pdf") {
      setExtracting(true);
      try {
        setReportText(await extractPdfText(next));
      } catch {
        toast.message("Couldn't read text from this PDF — paste it below if you want it scanned for flags.");
      } finally {
        setExtracting(false);
      }
    }
  }

  // Live preview of what the filter will flag — same function the server runs.
  const previewFlags = detectReportFlags({
    reportType,
    contractPrice: contractPrice ? Number(contractPrice) : null,
    appraisedValue: appraisedValue ? Number(appraisedValue) : null,
    reportText,
  });

  function reset() {
    setTitle("");
    setVendor("");
    setReportDate("");
    setAppraisedValue("");
    setReportText("");
    setSupersedes("");
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return toast.error("Choose the report file.");
    if (!ACCEPTED.includes(file.type)) return toast.error("Only PDF, JPG or PNG files are accepted.");
    if (file.size > MAX_BYTES) return toast.error("Files must be under 20MB.");
    if (!title.trim()) return toast.error("Give the report a title.");
    if (reportType === "appraisal" && !appraisedValue) return toast.error("Enter the appraised value.");

    setBusy(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return toast.error("Your session expired — sign in again.");
      const ext = file.name.split(".").pop() ?? "pdf";
      const path = `${uid}/${id}/report-${reportType}-${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("property-documents")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) return toast.error("Upload failed — try again.");

      const result = await deliverFn({
        data: {
          propertyId: id,
          reportType,
          title: title.trim(),
          vendorName: vendor.trim() || null,
          reportDate: reportDate || null,
          fileUrl: path,
          contentHash: await hashFile(file),
          contractPrice: reportType === "appraisal" && contractPrice ? Number(contractPrice) : null,
          appraisedValue: reportType === "appraisal" && appraisedValue ? Number(appraisedValue) : null,
          reportText: reportText || null,
          supersedesReportId: supersedes || null,
        },
      });
      toast.success(
        `Delivered to ${result.buyerNotices} Buyer Account(s) and ${result.agentNotices} Resident Agent(s)` +
          (result.flags.length ? ` — ${result.flags.length} priority flag(s) sent.` : "."),
      );
      reset();
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delivery failed");
    } finally {
      setBusy(false);
    }
  }

  const replaceable = reports.filter((r) => r.report_type === reportType && !r.superseded);

  return (
    <div>
      <Link
        to="/admin/properties"
        className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground"
      >
        ← Properties
      </Link>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-foreground">
        Appraisal & inspection reports
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {label || "Subject property"} — each report is stored in the Data Room and placed in the Due
        Diligence Inventory as a Required document, then delivered to every reserved Buyer Account and
        its Resident Agent.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-3 rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-foreground">Record a received report</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-muted-foreground">
            Report type
            <select
              value={reportType}
              onChange={(e) => {
                setReportType(e.target.value as ReportType);
                setSupersedes("");
              }}
              className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="inspection">{REPORT_TYPE_LABELS.inspection}</option>
              <option value="appraisal">{REPORT_TYPE_LABELS.appraisal}</option>
            </select>
          </label>
          <label className="block text-xs text-muted-foreground">
            Report file (PDF, JPG or PNG)
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm text-foreground"
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            Title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Home inspection — Acme Inspections"
              className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            Vendor (optional)
            <input
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            Report date (optional)
            <input
              type="date"
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          {replaceable.length > 0 ? (
            <label className="block text-xs text-muted-foreground">
              Revision of an earlier report?
              <select
                value={supersedes}
                onChange={(e) => setSupersedes(e.target.value)}
                className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              >
                <option value="">No — a new report</option>
                {replaceable.map((r) => (
                  <option key={r.id} value={r.id}>
                    Replaces: {r.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {reportType === "appraisal" ? (
            <>
              <label className="block text-xs text-muted-foreground">
                Appraised value stated in the report ($)
                <input
                  type="number"
                  min="1"
                  value={appraisedValue}
                  onChange={(e) => setAppraisedValue(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                Contract price ($)
                <input
                  type="number"
                  min="1"
                  value={contractPrice}
                  onChange={(e) => setContractPrice(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              </label>
            </>
          ) : null}
        </div>

        <label className="block text-xs text-muted-foreground">
          Report text {extracting ? "(reading PDF…)" : "(extracted from the PDF — used only to scan for flag phrases)"}
          <textarea
            value={reportText}
            onChange={(e) => setReportText(e.target.value)}
            rows={4}
            placeholder="Paste the report text here if it's a scanned image."
            className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground"
          />
        </label>

        <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          {previewFlags.length > 0 ? (
            <>
              <p className="font-medium text-foreground">
                These priority flags will be sent with the delivery:
              </p>
              <ul className="mt-1 list-disc pl-5">
                {previewFlags.map((f, i) => (
                  <li key={i}>{f.message}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>No flags detected — a standard delivery notice will be sent.</p>
          )}
          <p className="mt-2">{DELIVERY_NOTICE}</p>
        </div>

        <button
          type="submit"
          disabled={busy || extracting}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          <Upload className="h-4 w-4" />
          {busy ? "Delivering…" : "Store & deliver report"}
        </button>
      </form>

      <h2 className="mt-8 text-sm font-semibold text-foreground">Delivered reports</h2>
      <div className="mt-3 space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reports delivered for this property yet.</p>
        ) : (
          reports.map((r) => (
            <ReportCard key={r.id} report={r} signedUrl={r.signed_url} superseded={r.superseded} />
          ))
        )}
      </div>
    </div>
  );
}
