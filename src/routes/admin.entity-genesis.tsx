import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2 } from "lucide-react";
import { listEntityGenesis } from "@/lib/entity-genesis.functions";

export const Route = createFileRoute("/admin/entity-genesis")({
  component: AdminEntityGenesis,
});

function date(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

function AdminEntityGenesis() {
  const load = useServerFn(listEntityGenesis);
  const { data: entities = [], isLoading } = useQuery({
    queryKey: ["admin-entity-genesis"],
    queryFn: () => load({}),
  });

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">Entity Genesis</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Stage 1 (Digital Genesis) opens automatically at Hard-Lock — the first 1/8th share
          reserved. Stage 2 (Delaware filing via Stripe Atlas, EIN, TIN matching and the executed
          Operating Agreement) opens at Closing-Ready. Each property is a standalone Delaware LLC managed by divieight, LLC; the cap
          table below reflects who holds what right now.
        </p>
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading entities…</p>
      ) : entities.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No property has reached Hard-Lock yet.
        </div>
      ) : (
        <div className="space-y-4">
          {entities.map((e) => (
            <section key={e.id} className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent">
                    <Building2 className="h-4 w-4" />
                    {e.stage === "state_filed" ? "State filed" : "Digital genesis"}
                  </p>
                  <h2 className="font-display text-lg font-semibold text-foreground">
                    {e.address}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {e.city}, {e.state} {e.zip}
                  </p>
                  <p className="mt-2 text-sm text-foreground">{e.llcName}</p>
                  <p className="text-xs text-muted-foreground">
                    EIN: {e.ein ?? "pending Stage 2"} · Draft operating agreement:{" "}
                    {e.draftOperatingAgreementUrl ?? "not generated"}
                  </p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <p>Opened {date(e.createdAt)}</p>
                  <p>Cap table updated {date(e.capTableGeneratedAt)}</p>
                  <Link
                    to="/admin/entity-genesis/$propertyId"
                    params={{ propertyId: e.propertyId }}
                    className="mt-2 inline-block font-medium text-accent underline-offset-4 hover:underline"
                  >
                    Stage 2 — filing, EIN & signing →
                  </Link>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4">Unit</th>
                      <th className="py-2 pr-4">Holder</th>
                      <th className="py-2 pr-4">Members</th>
                      <th className="py-2 pr-4">Acquired</th>
                      <th className="py-2">Retention Lock ends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.capTable.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-3 text-muted-foreground">
                          No shares recorded yet.
                        </td>
                      </tr>
                    ) : (
                      e.capTable.map((r) => (
                        <tr key={r.shareNumber} className="border-t border-border">
                          <td className="py-2 pr-4">{r.shareNumber} of 8</td>
                          <td className="py-2 pr-4">
                            {r.holderType === "retained_seller"
                              ? "Retained seller share"
                              : "Buyer account"}
                          </td>
                          <td className="py-2 pr-4">
                            {r.memberNames.length > 0 ? r.memberNames.join(" & ") : "—"}
                          </td>
                          <td className="py-2 pr-4">{date(r.acquisitionDate)}</td>
                          <td className="py-2">{date(r.retentionLockExpiresAt)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
