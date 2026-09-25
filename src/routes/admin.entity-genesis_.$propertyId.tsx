import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CheckCircle2, Circle, ExternalLink, ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { hashFile } from "@/lib/due-diligence";
import { ATLAS_FEE_USD, TIN_MATCH_LABELS, type TinMatchResult } from "@/lib/entity-genesis";
import { getStage2, runStage2Action } from "@/lib/entity-genesis-stage2.functions";

export const Route = createFileRoute("/admin/entity-genesis_/$propertyId")({
  head: () => ({
    meta: [
      { title: "Entity Genesis Stage 2 — divieight admin" },
      { name: "description", content: "Delaware filing, EIN, TIN matching and the executed Operating Agreement." },
      { property: "og:title", content: "Entity Genesis Stage 2 — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Stage2Page,
});

const input = "mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
const primary = "rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50";

function when(v: string | null | undefined) {
  return v ? new Date(v).toLocaleString() : null;
}

function Step({ done, title, detail, children }: { done: boolean; title: string; detail?: string | null; children?: ReactNode }) {
  return (
    <li className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start gap-3">
        {done ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">{title}</p>
          {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
          {children ? <div className="mt-3">{children}</div> : null}
        </div>
      </div>
    </li>
  );
}

async function uploadToVaultBucket(propertyId: string, file: File, kind: string) {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Your session expired — sign in again.");
  const ext = file.name.split(".").pop() ?? "pdf";
  // Storage policy only lets a user write under their own uid folder.
  const path = `${auth.user.id}/entity-genesis/${propertyId}/${kind}-${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("property-documents").upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(`Upload failed — ${error.message}`);
  return { path, hash: await hashFile(file) };
}

function Stage2Page() {
  const { propertyId } = Route.useParams();
  const qc = useQueryClient();
  const load = useServerFn(getStage2);
  const run = useServerFn(runStage2Action);
  const { data, isLoading, error } = useQuery({ queryKey: ["stage2", propertyId], queryFn: () => load({ data: { propertyId } }) });

  const [atlasRef, setAtlasRef] = useState("");
  const [llcName, setLlcName] = useState("");
  const [fileNumber, setFileNumber] = useState("");
  const [certFile, setCertFile] = useState<File | null>(null);
  const [ein, setEin] = useState("");
  const [einFile, setEinFile] = useState<File | null>(null);
  const [tin, setTin] = useState<TinMatchResult>("match");

  const act = useMutation({
    mutationFn: async (build: () => Promise<Parameters<typeof run>[0]["data"]["action"]>) =>
      run({ data: { propertyId, action: await build() } }),
    onSuccess: () => {
      toast.success("Saved.");
      void qc.invalidateQueries({ queryKey: ["stage2", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error || !data) return <p className="text-sm text-destructive">{(error as Error)?.message ?? "Unavailable"}</p>;
  const g = data.genesis;
  const p = data.property;

  return (
    <div>
      <Link to="/admin/entity-genesis" className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground">
        ← Entity Genesis
      </Link>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-foreground">Stage 2 — State filing + EIN</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {p ? `${p.address}, ${p.city}, ${p.state} ${p.zip}` : "Property"} · {g?.llc_name ?? "Stage 1 not opened"}
      </p>

      <div className={`mt-4 flex gap-2 rounded-xl border p-3 text-sm ${data.llcFinancials.ok ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-destructive/40 bg-destructive/5 text-destructive"}`}>
        {data.llcFinancials.ok ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <ShieldAlert className="h-5 w-5 shrink-0" />}
        <p>{data.llcFinancials.message}</p>
      </div>

      {!g ? (
        <p className="mt-6 text-sm text-muted-foreground">Stage 1 opens at Hard-Lock (first share reserved).</p>
      ) : (
        <ol className="mt-6 space-y-3">
          <Step
            done={Boolean(g.cap_table_locked_at)}
            title="1. Closing-Ready — cap table locked"
            detail={`Pod: ${data.pod.retained} retained + ${data.pod.reserved} reserved = ${data.pod.total}/8${g.cap_table_locked_at ? ` · locked ${when(g.cap_table_locked_at)}` : ""}`}
          >
            {!g.cap_table_locked_at ? (
              <button className={primary} disabled={!data.pod.full || act.isPending} onClick={() => act.mutate(async () => ({ kind: "closing_ready" }))}>
                {data.pod.full ? "Mark Closing-Ready & lock cap table" : "Pod not full yet"}
              </button>
            ) : null}
          </Step>

          <Step
            done={g.atlas_request_status !== "not_requested"}
            title={`2. Request Stripe Atlas ($${ATLAS_FEE_USD} — Delaware filing + EIN)`}
            detail={g.atlas_requested_at ? `Requested ${when(g.atlas_requested_at)}${g.atlas_reference ? ` · ref ${g.atlas_reference}` : ""} · ${g.atlas_request_status}` : "Submit the application in Stripe Atlas, then record it here."}
          >
            {g.cap_table_locked_at && g.atlas_request_status === "not_requested" ? (
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-muted-foreground">
                  Atlas application reference
                  <input value={atlasRef} onChange={(e) => setAtlasRef(e.target.value)} className={input} />
                </label>
                <button className={primary} disabled={act.isPending} onClick={() => act.mutate(async () => ({ kind: "atlas_request", reference: atlasRef }))}>
                  Record Atlas request
                </button>
              </div>
            ) : null}
          </Step>

          <Step done={g.state_filing_status !== "pending"} title="3. Delaware filing submitted" detail={g.filed_at ? `Filed ${when(g.filed_at)}` : null}>
            {g.atlas_request_status !== "not_requested" && g.state_filing_status === "pending" ? (
              <button className={primary} disabled={act.isPending} onClick={() => act.mutate(async () => ({ kind: "state_filed" }))}>
                Mark filed with Delaware
              </button>
            ) : null}
          </Step>

          <Step
            done={g.state_filing_status === "confirmed"}
            title="4. Filing confirmed — Certificate of Formation to the Records Vault"
            detail={g.delaware_file_number ? `Delaware file no. ${g.delaware_file_number}` : null}
          >
            {g.state_filing_status === "filed" ? (
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="text-xs text-muted-foreground">
                  LLC name exactly as filed
                  <input value={llcName} onChange={(e) => setLlcName(e.target.value)} className={input} />
                </label>
                <label className="text-xs text-muted-foreground">
                  Delaware file number
                  <input value={fileNumber} onChange={(e) => setFileNumber(e.target.value)} className={input} />
                </label>
                <label className="text-xs text-muted-foreground">
                  Certificate of Formation (PDF)
                  <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => setCertFile(e.target.files?.[0] ?? null)} className="mt-1 block text-sm" />
                </label>
                <button
                  className={`${primary} sm:col-span-3 sm:w-fit`}
                  disabled={act.isPending || !certFile}
                  onClick={() =>
                    act.mutate(async () => {
                      const up = await uploadToVaultBucket(propertyId, certFile!, "certificate-of-formation");
                      return { kind: "state_confirmed", llcName, delawareFileNumber: fileNumber, certificateFileUrl: up.path, certificateHash: up.hash };
                    })
                  }
                >
                  Confirm filing
                </button>
              </div>
            ) : null}
          </Step>

          <Step
            done={g.ein_status !== "pending"}
            title="5. EIN issued — confirmation to the Records Vault"
            detail={g.ein ? `EIN ${g.ein} · issued ${when(g.ein_issued_at)}` : null}
          >
            {g.cap_table_locked_at && g.ein_status === "pending" ? (
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-muted-foreground">
                  EIN (12-3456789)
                  <input value={ein} onChange={(e) => setEin(e.target.value)} className={input} />
                </label>
                <label className="text-xs text-muted-foreground">
                  IRS confirmation (CP 575)
                  <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => setEinFile(e.target.files?.[0] ?? null)} className="mt-1 block text-sm" />
                </label>
                <button
                  className={primary}
                  disabled={act.isPending || !einFile}
                  onClick={() =>
                    act.mutate(async () => {
                      const up = await uploadToVaultBucket(propertyId, einFile!, "ein-confirmation");
                      return { kind: "ein", ein, confirmationFileUrl: up.path, confirmationHash: up.hash };
                    })
                  }
                >
                  Record EIN
                </button>
              </div>
            ) : null}
          </Step>

          <Step
            done={g.tin_match_result === "match"}
            title="6. IRS TIN Matching"
            detail={
              g.tin_match_result
                ? `${TIN_MATCH_LABELS[g.tin_match_result]} · checked ${when(g.tin_checked_at)}`
                : "Manual entry until the IRS e-Services TIN Matching account is approved. LLC financial transactions stay blocked until 'match'."
            }
          >
            {g.ein_status !== "pending" && g.tin_match_result !== "match" ? (
              <div className="flex flex-wrap items-end gap-2">
                <select value={tin} onChange={(e) => setTin(e.target.value as TinMatchResult)} className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
                  {(Object.keys(TIN_MATCH_LABELS) as TinMatchResult[]).map((k) => (
                    <option key={k} value={k}>
                      {TIN_MATCH_LABELS[k]}
                    </option>
                  ))}
                </select>
                <button className={primary} disabled={act.isPending} onClick={() => act.mutate(async () => ({ kind: "tin_match", result: tin }))}>
                  Record result
                </button>
              </div>
            ) : null}
          </Step>

          <Step
            done={g.final_oa_status === "executed"}
            title="7. Final Operating Agreement — all Buyer Account members sign in parallel"
            detail={
              g.final_oa_status === "executed"
                ? `Executed ${when(g.oa_executed_at)}`
                : g.final_oa_status === "awaiting_signatures"
                  ? `${data.signers.filter((s) => s.signedAt).length}/${data.signers.length} signed`
                  : "Generated from the locked cap table once the filing is confirmed."
            }
          >
            {g.final_oa_status === "not_started" ? (
              <button
                className={primary}
                disabled={act.isPending || !g.cap_table_locked_at || g.state_filing_status !== "confirmed"}
                onClick={() => act.mutate(async () => ({ kind: "final_oa" }))}
              >
                Generate final agreement & open signing
              </button>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.signers.map((s, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span>{s.name}</span>
                    <span className="text-xs text-muted-foreground">{s.signedAt ? `signed ${when(s.signedAt)}` : "awaiting"}</span>
                  </li>
                ))}
              </ul>
            )}
          </Step>
        </ol>
      )}

      <h2 className="mt-8 text-sm font-semibold text-foreground">Property Records Vault</h2>
      <ul className="mt-3 space-y-2">
        {data.vault.length === 0 ? (
          <li className="text-sm text-muted-foreground">Nothing stored yet.</li>
        ) : (
          data.vault.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 text-sm">
              <span>
                <span className="font-medium text-foreground">{v.title ?? v.document_type}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {v.document_type} · {when(v.stored_at)}
                </span>
              </span>
              {v.signed_url ? (
                <a href={v.signed_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                  Open <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
