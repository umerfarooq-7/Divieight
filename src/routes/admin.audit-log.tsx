import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { getAuditVault } from "@/lib/audit-vault.functions";
import {
  runEnrollmentMaintenance,
  type MaintenanceRunResult,
} from "@/lib/enrollment-maintenance.functions";
import { GRACE_DAYS, STALL_DAYS } from "@/lib/enrollment-maintenance";

// Gated by the /admin layout: only accounts holding the `admin` role in
// user_roles can reach this page (checked server-side via has_role).
//
// PII Sub-Vault access controls (restricting sensitive fields like SSN, ID
// documents) will be implemented in Month 4 when compliance officer roles
// exist — for now, identity document URLs and personal data remain in the
// regular properties/sellers tables, not yet PII-segmented.

export const Route = createFileRoute("/admin/audit-log")({
  head: () => ({
    meta: [
      { title: "Audit log — divieight admin" },
      { name: "description", content: "Append-only record of seller module actions." },
    ],
  }),
  component: AuditLogPage,
});

type AuditRow = {
  id: string;
  actor_id: string | null;
  actor_type: string;
  action_type: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

function AuditLogPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<MaintenanceRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  async function fireMaintenance() {
    setRunning(true);
    setRunError(null);
    try {
      const result = await runEnrollmentMaintenance();
      setRunResult(result);
      const { rows: fresh } = await getAuditVault({ data: { limit: 500 } });
      setRows((fresh as AuditRow[] | null) ?? []);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Maintenance run failed");
    } finally {
      setRunning(false);
    }
  }


  useEffect(() => {
    (async () => {
      // Read through the logged door: opening this page is itself a row in the Audit Vault.
      try {
        const { rows: fresh } = await getAuditVault({ data: { limit: 500 } });
        setRows((fresh as AuditRow[] | null) ?? []);
      } catch (e) {
        console.error(e);
      }
      setLoading(false);
    })();
  }, []);

  const actions = useMemo(
    () =>
      Array.from(
        new Set(
          rows
            .filter((r) => actorFilter === "all" || r.actor_type === actorFilter)
            .map((r) => r.action_type),
        ),
      ).sort(),
    [rows, actorFilter],
  );

  // Seller, buyer, agent and broker are always offered — a filter option must
  // exist even before the first row of that actor type lands in the log.
  const actorTypes = useMemo(
    () =>
      Array.from(
        new Set(["seller", "buyer", "agent", "broker", ...rows.map((r) => r.actor_type)]),
      ).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (actorFilter !== "all" && r.actor_type !== actorFilter) return false;
      if (actionFilter !== "all" && r.action_type !== actionFilter) return false;
      if (!q) return true;
      return (
        r.action_type.toLowerCase().includes(q) ||
        (r.actor_id ?? "").toLowerCase().includes(q) ||
        (r.entity_id ?? "").toLowerCase().includes(q) ||
        (r.entity_type ?? "").toLowerCase().includes(q) ||
        JSON.stringify(r.metadata ?? {}).toLowerCase().includes(q)
      );
    });
  }, [rows, search, actionFilter, actorFilter]);


  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            Admin · Internal
          </p>
          <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground">
            Audit log
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Append-only record of every significant seller, buyer, agent and broker action.
            Rows here cannot be edited or deleted.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search actor, entity, metadata…"
            className="h-10 w-72 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <select
            value={actorFilter}
            onChange={(e) => {
              setActorFilter(e.target.value);
              setActionFilter("all");
            }}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All actors</option>
            {actorTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      </div>

      <section className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-semibold text-foreground">
              Enrollment maintenance sweep
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Warns buyers who paid the enrollment fee but have been inactive for{" "}
              {STALL_DAYS} days, and forfeits priority rank {GRACE_DAYS} days after the
              warning. No cron scheduler is wired yet — fire it manually here for testing.
            </p>
          </div>
          <button
            type="button"
            onClick={fireMaintenance}
            disabled={running}
            className="h-10 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-sm transition hover:opacity-90 disabled:opacity-60"
          >
            {running ? "Running…" : "Run maintenance check"}
          </button>
        </div>

        {runError && <p className="mt-4 text-sm text-destructive">{runError}</p>}

        {runResult && (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-4 text-sm">
            <p className="font-medium text-foreground">
              Scanned {runResult.scanned} · warned {runResult.warned} · forfeited{" "}
              {runResult.forfeited}
            </p>
            {runResult.rows.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {runResult.rows.map((r) => (
                  <li key={r.buyerAccountId} className="font-mono">
                    {r.email} — {r.action} ({r.daysInactive}d inactive, {r.graceDaysLeft}d
                    grace left)
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>



      <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Timestamp</th>
                <th className="px-4 py-3 text-left font-medium">Actor</th>
                <th className="px-4 py-3 text-left font-medium">Action</th>
                <th className="px-4 py-3 text-left font-medium">Entity</th>
                <th className="px-4 py-3 text-left font-medium">Metadata</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No audit events match your filters.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.id} className="align-top hover:bg-muted/30">
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-foreground">
                      <div>{r.actor_type}</div>
                      <div className="text-muted-foreground">
                        {r.actor_id ? `${r.actor_id.slice(0, 8)}…` : "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                        {r.action_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <div className="font-medium text-foreground">{r.entity_type ?? "—"}</div>
                      <div className="font-mono text-muted-foreground">
                        {r.entity_id ? `${r.entity_id.slice(0, 8)}…` : "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <pre className="max-w-md overflow-x-auto rounded bg-muted/40 p-2 text-[11px] leading-snug text-foreground/80">
                        {JSON.stringify(r.metadata ?? {}, null, 0)}
                      </pre>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Showing {filtered.length} of {rows.length} events (most recent 500).
      </p>
    </div>
  );
}
