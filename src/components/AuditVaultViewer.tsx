import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { acknowledgeSecurityAlert, getAuditVault, getAuditVaultOverview, verifyAuditChainNow } from "@/lib/audit-vault.functions";
import { COVERAGE_LABELS } from "@/lib/audit-inventory";

type Tab = "checks" | "log" | "inventory";

const field = "mt-1 block rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const th = "px-3 py-2 text-left text-sm font-semibold text-foreground";
const td = "px-3 py-2 align-top text-sm text-foreground";

/** The Audit Vault, read-only. Every view of it is itself logged. */
export function AuditVaultViewer() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("checks");
  const overview = useQuery({ queryKey: ["audit-vault-overview"], queryFn: () => getAuditVaultOverview(), retry: false });
  const forbidden = (overview.error as Error | null)?.message === "Not authorized";

  const verify = useMutation({
    mutationFn: () => verifyAuditChainNow(),
    onSuccess: (r) => {
      toast[r.ok ? "success" : "error"](r.installed ? (r.ok ? `Chain verified: ${r.rowsChecked} rows, no tampering found.` : `Chain broken: ${r.reason}`) : "The Audit Vault hardening is not installed yet.");
      void qc.invalidateQueries({ queryKey: ["audit-vault-overview"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const ack = useMutation({
    mutationFn: (v: { alertId: string; note: string }) => acknowledgeSecurityAlert({ data: v }),
    onSuccess: () => {
      toast.success("Acknowledged.");
      void qc.invalidateQueries({ queryKey: ["audit-vault-overview"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (forbidden) return <p role="alert" className="mx-auto max-w-3xl px-4 py-16 text-center text-base text-destructive">403: only the Manager, the Compliance Officer and auditors can read the Audit Vault.</p>;

  const o = overview.data;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="font-display text-2xl font-semibold text-foreground">Audit Vault</h1>
      <p className="mt-1 text-base text-muted-foreground">Read-only. Append-only and hash-chained in the database. Every time this is opened, that is logged too.</p>
      <div role="tablist" aria-label="Audit Vault" className="mt-4 flex flex-wrap gap-2">
        {([["checks", "Chain and alerts"], ["log", "Log"], ["inventory", "Completeness inventory"]] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`h-10 rounded-md border px-4 text-sm font-medium ${tab === k ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-muted"}`}>
            {label}
          </button>
        ))}
      </div>
      {overview.isLoading ? <p className="mt-6 text-base text-muted-foreground">Loading…</p> : null}
      {overview.error && !forbidden ? <p role="alert" className="mt-6 text-base text-destructive">{(overview.error as Error).message}</p> : null}

      {o && tab === "checks" ? (
        <section className="mt-6 space-y-6">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-foreground">Hash chain</h2>
                {o.status.checkpoints[0] ? (
                  <p className="text-base text-foreground">
                    Last check {new Date(o.status.checkpoints[0].verified_at).toLocaleString()}: <strong>{o.status.checkpoints[0].ok ? "intact" : "BROKEN"}</strong>, {o.status.checkpoints[0].rows_checked} rows ({o.status.checkpoints[0].source}).
                    {o.status.checkpoints[0].ok ? null : ` ${o.status.checkpoints[0].reason ?? ""}`}
                  </p>
                ) : (
                  <p className="text-base text-muted-foreground">No check recorded yet. The nightly job records one; run one now.</p>
                )}
              </div>
              <button type="button" onClick={() => verify.mutate()} disabled={verify.isPending} className="inline-flex h-11 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                {verify.isPending ? "Verifying…" : "Verify the chain now"}
              </button>
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold text-foreground">Suspicious Activity Alerts ({o.status.openAlerts} open)</h2>
            {o.alerts.length === 0 ? <p className="mt-2 text-base text-muted-foreground">No alerts.</p> : null}
            <ul className="mt-3 space-y-3">
              {o.alerts.map((a) => (
                <li key={a.id} className="rounded-lg border border-border p-3 text-base">
                  <p className="font-medium text-foreground">
                    {a.label} <span className="font-normal text-muted-foreground">· {a.severity} · {new Date(a.detected_at).toLocaleString()}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {a.subject_table ? `Table ${a.subject_table}` : ""} {a.subject_pk ? `· record ${String(a.subject_pk).slice(0, 8)}` : ""} · {String((a.detail as Record<string, unknown>)?.why ?? "")}
                  </p>
                  <p className="text-sm text-muted-foreground">{a.notified_at ? `Compliance Officer told ${new Date(a.notified_at).toLocaleString()}.` : "Compliance Officer not yet told."}</p>
                  {a.acknowledged_at ? (
                    <p className="mt-1 text-sm text-foreground">Acknowledged {new Date(a.acknowledged_at).toLocaleString()}: {a.acknowledgement_note}</p>
                  ) : (
                    <form
                      className="mt-2 flex flex-wrap items-end gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const note = String(new FormData(e.currentTarget).get("note") ?? "");
                        ack.mutate({ alertId: a.id, note });
                      }}
                    >
                      <label className="text-sm font-medium text-foreground">
                        What you found and did
                        <input name="note" className={`${field} w-72`} />
                      </label>
                      <button type="submit" className="h-10 rounded-md border border-border bg-background px-4 text-sm font-medium hover:bg-muted">
                        Acknowledge
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {o && tab === "log" ? <LogTab /> : null}

      {o && tab === "inventory" ? (
        <section className="mt-6">
          <p className="text-base text-muted-foreground">Every state-changing event, and whether it writes to the Audit Vault. A test fails if a critical action stops writing its row.</p>
          <div className="mt-3 overflow-x-auto rounded-lg border border-border">
            <table className="min-w-full divide-y divide-border">
              <thead className="bg-muted/50">
                <tr>{["Area", "Event", "Audited", "How", "Status"].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-border">
                {o.inventory.map((e, i) => (
                  <tr key={i}>
                    <td className={td}>{e.area}</td>
                    <td className={td}>{e.event}{e.note ? <span className="block text-muted-foreground">{e.note}</span> : null}</td>
                    <td className={td}>Yes</td>
                    <td className={td}>{[e.actions?.length ? `App: ${e.actions.join(", ")}` : null, e.tables?.length ? `Database: ${e.tables.join(", ")}` : null].filter(Boolean).join(" · ")}</td>
                    <td className={td}>{COVERAGE_LABELS[e.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function LogTab() {
  const [action, setAction] = useState("");
  const [entity, setEntity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState({ action: "", entity: "", from: "", to: "" });
  const log = useQuery({ queryKey: ["audit-vault-log", applied], queryFn: () => getAuditVault({ data: { filters: { action: applied.action || null, entity: applied.entity || null, from: applied.from || null, to: applied.to || null }, limit: 200 } }), retry: false });
  return (
    <section className="mt-6">
      <form
        className="flex flex-wrap items-end gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ action, entity, from, to });
        }}
      >
        <label className="text-sm font-medium text-foreground">Action<input value={action} onChange={(e) => setAction(e.target.value)} className={field} placeholder="e.g. entity.cap_table_updated" /></label>
        <label className="text-sm font-medium text-foreground">Record id<input value={entity} onChange={(e) => setEntity(e.target.value)} className={field} /></label>
        <label className="text-sm font-medium text-foreground">From<input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={field} /></label>
        <label className="text-sm font-medium text-foreground">To<input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={field} /></label>
        <button type="submit" className="h-11 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90">Search (logged)</button>
      </form>
      {log.isLoading ? <p className="mt-4 text-base text-muted-foreground">Loading…</p> : null}
      {log.error ? <p role="alert" className="mt-4 text-base text-destructive">{(log.error as Error).message}</p> : null}
      {log.data ? (
        <div className="mt-4 overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-muted/50"><tr>{["When (UTC)", "Who", "Action", "Entity", "Where", "Chain"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-border">
              {log.data.rows.map((r) => (
                <tr key={String(r.id)}>
                  <td className={`${td} whitespace-nowrap font-mono`}>{new Date(r.created_at).toISOString()}</td>
                  <td className={td}>{r.actor_type}{r.actor_id ? ` · ${String(r.actor_id).slice(0, 8)}` : ""}{r.acting_member_id ? ` (member ${String(r.acting_member_id).slice(0, 8)})` : ""}</td>
                  <td className={td}>{r.action_type}</td>
                  <td className={td}>{r.entity_type ?? ""}{r.entity_id ? ` · ${String(r.entity_id).slice(0, 12)}` : ""}</td>
                  <td className={td}>{[r.ip_address ?? r.metadata?.ip_address, r.route ?? r.metadata?.route].filter(Boolean).join(" · ")}</td>
                  <td className={`${td} font-mono`}>{r.seq != null ? `#${r.seq} ${String(r.row_hash ?? "").slice(0, 10)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
