import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { getDistributionBoard } from "@/lib/distributions.functions";
import {
  downloadTaxReadyFileFn,
  export1099NecFn,
  export1099NecWithTinsFn,
  generateTaxReadyFn,
  getAdminBrokerForms,
  getInfluencerBoard,
  getTaxReadyFolders,
  getVaultStatus,
  grantVaultFn,
  recordInfluencerPaymentFn,
  rejectBrokerFormFn,
  revealBrokerTinFn,
  revealInfluencerTinFn,
  revokeVaultFn,
  saveInfluencerPayeeFn,
  viewBrokerFormFn,
  voidInfluencerPaymentFn,
} from "@/lib/tax-forms.functions";
import { INFLUENCER_FILING_ASSUMPTION, TREATMENT_LABELS, type InfluencerTreatment } from "@/lib/tax-forms";
import { expenseMoney } from "@/lib/expenses";

export const Route = createFileRoute("/admin/tax")({
  head: () => ({
    meta: [
      { title: "Tax forms and data — divieight admin" },
      { name: "description", content: "Broker tax forms, influencer 1099-NEC data and the Tax-Ready Folder." },
      { property: "og:title", content: "Tax forms and data — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminTaxPage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";
const PRIMARY = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const SECONDARY = "rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50";
const money = (c: number) => expenseMoney(c / 100);
const TABS = [["brokers", "Broker tax forms"], ["influencers", "Influencers (1099-NEC)"], ["folder", "Tax-Ready Folder"], ["vault", "Tax vault access"]] as const;

function download(name: string, base64: string, type: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
const downloadText = (name: string, text: string, type: string) => download(name, btoa(unescape(encodeURIComponent(text))), type);

function AdminTaxPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("brokers");
  return (
    <div className="space-y-5">
      <h1 className="font-display text-2xl font-semibold text-foreground">Tax forms and data</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">
        No payout is released to a Broker of Record without a valid W-9 (or W-8BEN / W-8BEN-E for a non-US broker). Influencers are paid directly, never through a Broker of Record. Every read of a TIN or a tax form is logged. divieight records and exports the data; it does not file with the IRS.
      </p>
      <nav className="flex flex-wrap gap-2" aria-label="Sections">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? PRIMARY : SECONDARY} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "brokers" ? <BrokersSection /> : null}
      {tab === "influencers" ? <InfluencersSection /> : null}
      {tab === "folder" ? <FolderSection /> : null}
      {tab === "vault" ? <VaultSection /> : null}
    </div>
  );
}

function Why({ onSubmit, label }: { onSubmit: (reason: string) => void; label: string }) {
  const [reason, setReason] = useState("");
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <input className={`${FIELD} max-w-xs`} placeholder="Reason (logged)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="button" className={SECONDARY} disabled={!reason.trim()} onClick={() => onSubmit(reason)}>
        {label}
      </button>
    </div>
  );
}

function BrokersSection() {
  const qc = useQueryClient();
  const load = useServerFn(getAdminBrokerForms);
  const view = useServerFn(viewBrokerFormFn);
  const reject = useServerFn(rejectBrokerFormFn);
  const reveal = useServerFn(revealBrokerTinFn);
  const q = useQuery({ queryKey: ["tax-brokers"], queryFn: () => load(), retry: false });
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof view>> | null>(null);
  const [tin, setTin] = useState<string | null>(null);
  const onError = (e: Error) => toast.error(e.message);
  const viewM = useMutation({ mutationFn: (brokerId: string) => view({ data: { brokerId } }), onSuccess: (d) => { setDetail(d); setTin(null); }, onError });
  const rejectM = useMutation({ mutationFn: (v: { formId: string; reason: string }) => reject({ data: v }), onSuccess: () => { toast.success("Rejected. The broker is blocked until they submit a corrected form."); setDetail(null); void qc.invalidateQueries({ queryKey: ["tax-brokers"] }); }, onError });
  const revealM = useMutation({ mutationFn: (v: { formId: string; reason: string }) => reveal({ data: v }), onSuccess: (r) => setTin(r.tin), onError });
  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error) return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;
  return (
    <div className="space-y-3">
      {q.data!.brokers.map((b) => (
        <section key={b.id} className="rounded-xl border border-border bg-card p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-foreground">{b.brokerage}</span>
            <span className={b.allowed ? "text-foreground" : "font-medium text-destructive"}>
              {b.allowed ? `Cleared · ${b.formType}${b.expiry ? ` until ${b.expiry}` : ""}` : b.state === "missing" ? "Blocked: tax form missing" : `Blocked: tax form ${b.state}`}
            </span>
          </div>
          {b.formId ? (
            <button type="button" className={`${SECONDARY} mt-2`} onClick={() => { setOpen(b.id); viewM.mutate(b.id); }}>
              Open the form (logged)
            </button>
          ) : null}
          {open === b.id && detail ? (
            <div className="mt-3 space-y-2 rounded-lg border border-border p-3">
              <p>
                {detail.formType} · {detail.legalName} · {detail.address} · {detail.country}
              </p>
              <p className="text-muted-foreground">
                Signed by {detail.signedName} on {detail.signedAt.slice(0, 10)}
                {detail.expiry ? ` · expires ${detail.expiry}` : ""} · ID ending {detail.last4 ?? "none"}
              </p>
              {tin ? <p className="font-mono">{tin}</p> : <Why label="Show the tax ID (needs tax-vault access)" onSubmit={(reason) => revealM.mutate({ formId: detail.id, reason })} />}
              <Why label="Reject this form" onSubmit={(reason) => rejectM.mutate({ formId: detail.id, reason })} />
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function InfluencersSection() {
  const qc = useQueryClient();
  const [year, setYear] = useState(new Date().getUTCFullYear() - 1);
  const load = useServerFn(getInfluencerBoard);
  const savePayee = useServerFn(saveInfluencerPayeeFn);
  const pay = useServerFn(recordInfluencerPaymentFn);
  const voidIt = useServerFn(voidInfluencerPaymentFn);
  const exportGeneral = useServerFn(export1099NecFn);
  const exportTins = useServerFn(export1099NecWithTinsFn);
  const reveal = useServerFn(revealInfluencerTinFn);
  const q = useQuery({ queryKey: ["tax-influencers", year], queryFn: () => load({ data: { year } }), retry: false });
  const [p, setP] = useState({ name: "", formType: "", address: "", country: "", tinKind: "ssn", tin: "", signedOn: "" });
  const [pm, setPm] = useState({ payeeId: "", amount: "", paidAt: "", memo: "" });
  const [shown, setShown] = useState<Record<string, string>>({});
  const refresh = () => void qc.invalidateQueries({ queryKey: ["tax-influencers"] });
  const onError = (e: Error) => toast.error(e.message);
  const saveM = useMutation({ mutationFn: () => savePayee({ data: { name: p.name, formType: p.formType || null, address: p.address, country: p.country, tinKind: p.formType ? p.tinKind : null, tin: p.tin, signedOn: p.signedOn } }), onSuccess: () => { toast.success("Payee saved"); setP({ name: "", formType: "", address: "", country: "", tinKind: "ssn", tin: "", signedOn: "" }); refresh(); }, onError });
  const payM = useMutation({ mutationFn: () => pay({ data: pm }), onSuccess: () => { toast.success("Payment recorded"); setPm({ payeeId: "", amount: "", paidAt: "", memo: "" }); refresh(); }, onError });
  const voidM = useMutation({ mutationFn: (v: { paymentId: string; reason: string }) => voidIt({ data: v }), onSuccess: () => { toast.success("Voided"); refresh(); }, onError });
  const exportM = useMutation({ mutationFn: () => exportGeneral({ data: { year } }), onSuccess: (r) => { downloadText(`1099-nec-${year}.csv`, r.csv, "text/csv"); downloadText(`1099-nec-${year}.json`, JSON.stringify(r.json, null, 2), "application/json"); toast.success(`${r.payees.length} 1099-NEC payee(s); ${r.flaggedForCpa.length} flagged for the CPA`); }, onError });
  const tinsM = useMutation({ mutationFn: () => exportTins({ data: { year } }), onSuccess: (r) => { for (const f of r.files) download(f.name, f.base64, f.type); toast.success("The files with TINs were downloaded and kept in the private vault."); }, onError });
  const revealM = useMutation({ mutationFn: (v: { payeeId: string; reason: string }) => reveal({ data: v }), onSuccess: (r, v) => setShown((s) => ({ ...s, [v.payeeId]: r.tin })), onError });
  const b = q.data;
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{INFLUENCER_FILING_ASSUMPTION}</p>
      <label className="block text-xs font-medium text-foreground">
        Year
        <input type="number" className={`${FIELD} w-28`} value={year} onChange={(e) => setYear(Number(e.target.value))} />
      </label>
      {q.error ? <p className="text-sm text-destructive">{(q.error as Error).message}</p> : null}
      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Annual summary {year}</h3>
        {(b?.summary ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No payments in {year}.</p> : null}
        {b?.summary.map((r) => (
          <div key={r.payeeId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {r.name} <span className="text-muted-foreground">· {r.formType ?? "no form"}{r.last4 ? ` · ID ending ${r.last4}` : ""}</span>
            </span>
            <span className="text-right">
              {money(r.totalCents)} · {TREATMENT_LABELS[r.treatment as InfluencerTreatment]}
              {r.issue ? <span className="block text-xs text-destructive">{r.issue}</span> : null}
            </span>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={PRIMARY} disabled={exportM.isPending} onClick={() => exportM.mutate()}>
            1099-NEC data export (CSV and JSON)
          </button>
          <button type="button" className={SECONDARY} disabled={tinsM.isPending} onClick={() => tinsM.mutate()}>
            Export with TINs (tax-vault access)
          </button>
        </div>
      </section>
      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Add or update a payee</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-medium">Name<input className={FIELD} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></label>
          <label className="text-xs font-medium">
            Tax form
            <select className={FIELD} value={p.formType} onChange={(e) => setP({ ...p, formType: e.target.value })}>
              <option value="">None yet</option>
              <option value="W-9">W-9 (US)</option>
              <option value="W-8BEN">W-8BEN (non-US individual)</option>
              <option value="W-8BEN-E">W-8BEN-E (non-US entity)</option>
            </select>
          </label>
          <label className="text-xs font-medium">Date signed<input type="date" className={FIELD} value={p.signedOn} onChange={(e) => setP({ ...p, signedOn: e.target.value })} /></label>
          <label className="text-xs font-medium sm:col-span-2">Address<input className={FIELD} value={p.address} onChange={(e) => setP({ ...p, address: e.target.value })} /></label>
          {p.formType && p.formType !== "W-9" ? <label className="text-xs font-medium">Country (2 letters)<input className={FIELD} maxLength={2} value={p.country} onChange={(e) => setP({ ...p, country: e.target.value.toUpperCase() })} /></label> : <span />}
          {p.formType === "W-9" ? (
            <label className="text-xs font-medium">
              ID type
              <select className={FIELD} value={p.tinKind} onChange={(e) => setP({ ...p, tinKind: e.target.value })}>
                <option value="ssn">SSN</option>
                <option value="ein">EIN</option>
                <option value="itin">ITIN</option>
              </select>
            </label>
          ) : null}
          {p.formType ? <label className="text-xs font-medium">{p.formType === "W-9" ? "Tax ID" : "Foreign tax ID (if any)"}<input className={FIELD} autoComplete="off" value={p.tin} onChange={(e) => setP({ ...p, tin: e.target.value })} /></label> : null}
        </div>
        <button type="button" className={PRIMARY} disabled={!p.name.trim() || saveM.isPending} onClick={() => saveM.mutate()}>
          Save payee
        </button>
      </section>
      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground">Record a payment (made directly, not through a Broker of Record)</h3>
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="text-xs font-medium">
            Payee
            <select className={FIELD} value={pm.payeeId} onChange={(e) => setPm({ ...pm, payeeId: e.target.value })}>
              <option value="">Choose</option>
              {b?.payees.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium">Amount (USD)<input type="number" min="0.01" step="0.01" className={FIELD} value={pm.amount} onChange={(e) => setPm({ ...pm, amount: e.target.value })} /></label>
          <label className="text-xs font-medium">Paid on<input type="date" className={FIELD} value={pm.paidAt} onChange={(e) => setPm({ ...pm, paidAt: e.target.value })} /></label>
          <label className="text-xs font-medium">Memo<input className={FIELD} value={pm.memo} onChange={(e) => setPm({ ...pm, memo: e.target.value })} /></label>
        </div>
        <button type="button" className={PRIMARY} disabled={!pm.payeeId || !pm.amount || !pm.paidAt || payM.isPending} onClick={() => payM.mutate()}>
          Record payment
        </button>
      </section>
      <section className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm">
        <h3 className="font-semibold text-foreground">Payees and {year} payments</h3>
        {b?.payees.map((x) => (
          <div key={x.id} className="space-y-1 border-t border-border pt-2">
            <p className="font-medium">
              {x.name} <span className="text-muted-foreground">· {x.formType ?? "no tax form"} · {x.formStatus}</span>
            </p>
            {shown[x.id] ? <p className="font-mono">{shown[x.id]}</p> : x.formType ? <Why label="Show the tax ID (needs tax-vault access)" onSubmit={(reason) => revealM.mutate({ payeeId: x.id, reason })} /> : null}
            {b.payments.filter((y) => y.payeeId === x.id).map((y) => (
              <div key={y.id} className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                <span className={y.voided ? "line-through" : ""}>
                  {y.paidAt} · {money(y.amountCents)}
                  {y.memo ? ` · ${y.memo}` : ""}
                </span>
                {y.voided ? <span>Voided: {y.voidReason}</span> : <Why label="Void" onSubmit={(reason) => voidM.mutate({ paymentId: y.id, reason })} />}
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}

function FolderSection() {
  const qc = useQueryClient();
  const props = useServerFn(getDistributionBoard);
  const load = useServerFn(getTaxReadyFolders);
  const generate = useServerFn(generateTaxReadyFn);
  const get = useServerFn(downloadTaxReadyFileFn);
  const [propertyId, setPropertyId] = useState("");
  const [year, setYear] = useState(new Date().getUTCFullYear() - 1);
  const list = useQuery({ queryKey: ["tax-props"], queryFn: () => props({ data: { propertyId: null } }), retry: false });
  const q = useQuery({ queryKey: ["tax-folders", propertyId], enabled: !!propertyId, queryFn: () => load({ data: { propertyId } }), retry: false });
  const onError = (e: Error) => toast.error(e.message);
  const genM = useMutation({ mutationFn: () => generate({ data: { propertyId, year } }), onSuccess: (r) => { toast.success(`Version ${r.version}: ${r.files} files kept in the vault. ${r.reconciled ? "Ownership reconciles." : "Ownership does NOT reconcile: check the cap table."}`); void qc.invalidateQueries({ queryKey: ["tax-folders"] }); }, onError });
  const getM = useMutation({ mutationFn: (v: { folderId: string; file: string }) => get({ data: v }), onSuccess: (f) => download(f.filename, f.base64, f.filename.endsWith(".json") ? "application/json" : "text/csv"), onError });
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Per property per year: the 1099-S data from resales and the per-share ownership records, reconciled to the cap table, for the CPA&apos;s K-1 preparation. Kept in the private tax vault: only the founder, or an admin the founder has given access, can make or open one. It is included (without TINs) in the Year-End packet.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-medium">
          Property
          <select className={FIELD} value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            <option value="">Choose</option>
            {list.data?.properties.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium">Year<input type="number" className={`${FIELD} w-28`} value={year} onChange={(e) => setYear(Number(e.target.value))} /></label>
        <button type="button" className={PRIMARY} disabled={!propertyId || genM.isPending} onClick={() => genM.mutate()}>
          Generate the folder
        </button>
      </div>
      {q.error ? <p className="text-sm text-destructive">{(q.error as Error).message}</p> : null}
      {q.data?.folders.map((f) => (
        <section key={f.id} className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm">
          <p className="font-medium text-foreground">
            {f.year} · version {f.version} · {f.byJob ? "scheduled job" : "generated by a person"} · {f.generatedAt.slice(0, 10)} · {f.sales} sale(s) · {f.reconciled ? "reconciled" : "NOT reconciled"}
          </p>
          <p className="break-all text-xs text-muted-foreground">Hash {f.hash}</p>
          <div className="flex flex-wrap gap-2">
            {f.files.map((x) => (
              <button key={x.name} type="button" className={SECONDARY} onClick={() => getM.mutate({ folderId: f.id, file: x.name })}>
                {x.name}
                {x.pii ? " (TINs)" : ""}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function VaultSection() {
  const qc = useQueryClient();
  const load = useServerFn(getVaultStatus);
  const grant = useServerFn(grantVaultFn);
  const revoke = useServerFn(revokeVaultFn);
  const q = useQuery({ queryKey: ["tax-vault"], queryFn: () => load(), retry: false });
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const onError = (e: Error) => toast.error(e.message);
  const done = () => void qc.invalidateQueries({ queryKey: ["tax-vault"] });
  const grantM = useMutation({ mutationFn: () => grant({ data: { targetUserId: target, reason } }), onSuccess: () => { toast.success("Access granted"); setTarget(""); setReason(""); done(); }, onError });
  const revokeM = useMutation({ mutationFn: (id: string) => revoke({ data: { targetUserId: id } }), onSuccess: () => { toast.success("Access revoked"); done(); }, onError });
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">The tax vault holds the Tax-Ready Folders and the tax IDs of brokers and influencers. The founder has access. A regular admin, an agent or an owner does not, unless the founder grants it here.</p>
      <p className="font-medium text-foreground">You {q.data?.hasAccess ? "have" : "do not have"} access to the tax vault.</p>
      {q.data?.isFounder ? (
        <>
          <section className="space-y-2 rounded-xl border border-border bg-card p-4">
            <h3 className="font-semibold text-foreground">Grant access to an admin</h3>
            <input className={FIELD} placeholder="The admin's user id" value={target} onChange={(e) => setTarget(e.target.value)} />
            <input className={FIELD} placeholder="Why" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button type="button" className={PRIMARY} disabled={!target.trim() || !reason.trim() || grantM.isPending} onClick={() => grantM.mutate()}>
              Grant access
            </button>
          </section>
          {q.data.grants.map((g) => (
            <div key={g.userId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card p-3">
              <span>
                {g.userId} · since {g.grantedAt.slice(0, 10)}
                {g.reason ? ` · ${g.reason}` : ""}
              </span>
              <button type="button" className={SECONDARY} onClick={() => revokeM.mutate(g.userId)}>
                Revoke
              </button>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
