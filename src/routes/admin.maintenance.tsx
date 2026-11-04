import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MaintenancePhotos, MaintenanceStatusChip, MaintenanceTimeline, UrgentChip } from "@/components/owner/MaintenanceBits";
import { formatDate } from "@/lib/format-date";
import { MAINTENANCE_STATUS_LABELS, maintenanceMoney, type MaintenanceStatus } from "@/lib/maintenance";
import { attributeMaintenanceToLlc, listMaintenanceForAdmin, updateMaintenanceRequest } from "@/lib/maintenance.functions";
import type { AdminMaintenanceRequest } from "@/lib/maintenance.server";

export const Route = createFileRoute("/admin/maintenance")({
  head: () => ({
    meta: [
      { title: "Maintenance — divieight admin" },
      { name: "description", content: "Triage, estimate, approve and update owners' maintenance requests." },
      { property: "og:title", content: "Maintenance — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminMaintenancePage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";

function AdminMaintenancePage() {
  const load = useServerFn(listMaintenanceForAdmin);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-maintenance"],
    queryFn: () => load(),
    retry: false,
  });
  const rows = data?.rows ?? [];
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Maintenance</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Owners are told about every status change. A completed request with an actual cost can be attributed to the LLC operating
        account: it waits in a queue until the Expense system is built, then becomes an expense.
      </p>
      <div className="mt-6 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No maintenance requests yet.</p>
        ) : (
          rows.map((row) => <RequestCard key={row.id} row={row} />)
        )}
      </div>
    </div>
  );
}

function RequestCard({ row }: { row: AdminMaintenanceRequest }) {
  const qc = useQueryClient();
  const update = useServerFn(updateMaintenanceRequest);
  const attribute = useServerFn(attributeMaintenanceToLlc);
  const [status, setStatus] = useState<MaintenanceStatus | "">("");
  const [estimate, setEstimate] = useState(row.estimatedCost?.toString() ?? "");
  const [actual, setActual] = useState(row.actualCost?.toString() ?? "");
  const [vendor, setVendor] = useState(row.vendorName ?? "");
  const [note, setNote] = useState("");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin-maintenance"] });
  const saveMut = useMutation({
    mutationFn: () => update({ data: { requestId: row.id, status: status || null, estimatedCost: estimate, actualCost: actual, vendorName: vendor, note } }),
    onSuccess: () => {
      toast.success("Saved.");
      setStatus("");
      setNote("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const attributeMut = useMutation({
    mutationFn: () => attribute({ data: { requestId: row.id } }),
    onSuccess: () => {
      toast.success("Attributed and queued as an expense.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 break-words font-display text-base font-semibold text-foreground">{row.title}</h2>
        <div className="flex flex-wrap gap-1.5">
          <UrgentChip urgency={row.urgency} />
          <MaintenanceStatusChip status={row.status} />
        </div>
      </div>
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {row.propertyLabel} · {row.category} · {row.submittedBy} · {formatDate(row.createdAt)}
      </p>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{row.description}</p>
      <MaintenancePhotos urls={row.photoUrls} />
      <MaintenanceTimeline entries={row.timeline} />

      <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block text-sm font-medium text-foreground">
          Move to
          <select value={status} onChange={(e) => setStatus(e.target.value as MaintenanceStatus | "")} disabled={row.nextStatuses.length === 0} className={FIELD}>
            <option value="">{row.nextStatuses.length === 0 ? "Final status" : "No change"}</option>
            {row.nextStatuses.map((s) => (
              <option key={s} value={s}>
                {MAINTENANCE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-foreground">
          Estimated cost
          <input type="number" min="0" step="0.01" value={estimate} onChange={(e) => setEstimate(e.target.value)} className={FIELD} />
        </label>
        <label className="block text-sm font-medium text-foreground">
          Actual cost
          <input type="number" min="0" step="0.01" value={actual} disabled={Boolean(row.expenseQueuedAt)} onChange={(e) => setActual(e.target.value)} className={FIELD} />
        </label>
        <label className="block text-sm font-medium text-foreground">
          Vendor
          <input maxLength={200} value={vendor} onChange={(e) => setVendor(e.target.value)} className={FIELD} />
        </label>
      </div>
      <label className="mt-3 block text-sm font-medium text-foreground">
        Note {status === "rejected" ? "(required to reject)" : "(optional)"}: owners see this
        <textarea rows={2} maxLength={5000} value={note} onChange={(e) => setNote(e.target.value)} className={FIELD} />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={saveMut.isPending || (status === "rejected" && !note.trim())}
          onClick={() => saveMut.mutate()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {saveMut.isPending ? "Saving…" : "Save"}
        </button>
        {row.canAttribute ? (
          <button
            type="button"
            disabled={attributeMut.isPending}
            onClick={() => attributeMut.mutate()}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50"
          >
            Attribute {maintenanceMoney(row.actualCost ?? 0)} to LLC operating account
          </button>
        ) : null}
        {row.expenseQueuedAt ? (
          <span className="text-sm text-muted-foreground">
            {row.expenseLinked ? "Linked to an expense" : "Queued as an expense"} since {formatDate(row.expenseQueuedAt)}
          </span>
        ) : null}
      </div>
    </section>
  );
}
