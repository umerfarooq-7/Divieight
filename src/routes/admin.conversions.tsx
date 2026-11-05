import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { when } from "@/lib/admin";
import { listConversions, syncConversionsNow } from "@/lib/conversions.functions";
import type { ConversionStatus } from "@/lib/conversions.server";

export const Route = createFileRoute("/admin/conversions")({
  head: () => ({
    meta: [
      { title: "Conversions — divieight admin" },
      { name: "description", content: "Buyers who have executed the PRA and cleared the Platform Enrollment Fee." },
      { property: "og:title", content: "Conversions — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminConversionsPage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";
const KEY = "admin-conversions";

function AdminConversionsPage() {
  const load = useServerFn(listConversions);
  const sync = useServerFn(syncConversionsNow);
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConversionStatus | "">("");
  const [agentId, setAgentId] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: [KEY, status, agentId, propertyId, from, to],
    retry: false,
    queryFn: () => load({ data: { status: status || null, agentId: agentId || null, propertyId: propertyId || null, from: from || null, to: to || null } }),
  });
  const syncMut = useMutation({
    mutationFn: () => sync(),
    onSuccess: (r) => {
      toast.success(`Synced: ${r.converted} converted, ${r.partial} partial.`);
      void qc.invalidateQueries({ queryKey: [KEY] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground">Conversions</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            A buyer converts when the PRA is executed and the $2,570 Platform Enrollment Fee has cleared: both are required. The date is the later of the two. Read-only.
          </p>
        </div>
        <button
          type="button"
          disabled={syncMut.isPending}
          onClick={() => syncMut.mutate()}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50"
        >
          {syncMut.isPending ? "Syncing…" : "Sync now"}
        </button>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="block text-sm font-medium text-foreground">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as ConversionStatus | "")} className={FIELD}>
            <option value="">All</option>
            <option value="converted">Converted</option>
            <option value="partial">Partial</option>
          </select>
        </label>
        <label className="block text-sm font-medium text-foreground">
          Agent
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={FIELD}>
            <option value="">All</option>
            {data?.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-foreground">
          Property
          <select value={propertyId} onChange={(e) => setPropertyId(e.target.value)} className={FIELD}>
            <option value="">All</option>
            {data?.properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-foreground">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={FIELD} />
        </label>
        <label className="block text-sm font-medium text-foreground">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={FIELD} />
        </label>
      </div>

      {isLoading ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="mt-6 text-sm text-destructive">{error.message}</p>
      ) : !data ? null : (
        <>
          <p className="mt-5 text-sm text-foreground">
            <span className="font-semibold">{data.totals.converted}</span> converted · <span className="font-semibold">{data.totals.partial}</span> partial
            {data.truncated ? <span className="text-muted-foreground"> · showing the latest 1,000 only</span> : null}
          </p>
          <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  {["Buyer", "Status", "Property", "Attributed to", "PRA executed", "PEF cleared", "Converted"].map((h) => (
                    <th key={h} scope="col" className="px-4 py-3 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                      No conversion events match.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="break-all px-4 py-3 font-medium text-foreground">{r.buyerEmail}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${r.status === "converted" ? "bg-accent/10 text-accent" : "bg-muted text-muted-foreground"}`}>
                          {r.status === "converted" ? "Converted" : "Partial"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-foreground">{r.propertyLabel ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-foreground">{r.agentName ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{when(r.praExecutedAt)}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{when(r.pefClearedAt)}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{when(r.convertedAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
