import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { StatementView } from "@/components/StatementView";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { formatCents } from "@/lib/bank-feed-display";
import { getCpaCapitalAccounts, getCpaLedger, getCpaPackets, getCpaPortal, getCpaRoster, getCpaStatement, getCpaStatementPdf, getCpaStatements, getCpaWorksheet, revealCpaTinFn } from "@/lib/cpa.functions";
import { CAPITAL_TYPE_LABELS, STATEMENT_STATUS_LABELS, periodLabel, type StatementStatus } from "@/lib/statements";

export const Route = createFileRoute("/cpa/")({
  head: () => ({
    meta: [
      { title: "CPA — divieight" },
      { name: "description", content: "Read-only access to the LLC's books for its designated CPA." },
      { property: "og:title", content: "CPA — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CpaPage,
});

const TABS = [
  ["ledger", "General ledger"],
  ["capital", "Capital accounts"],
  ["statements", "Monthly statements"],
  ["members", "Members and TINs"],
  ["worksheet", "CPA Cooperation Worksheet"],
  ["packets", "Year-End Export Packets"],
] as const;
type Tab = (typeof TABS)[number][0];
const BTN = "rounded-lg border border-border px-4 py-2 text-base font-medium text-foreground hover:bg-secondary disabled:opacity-50";
const ON = "rounded-lg bg-primary px-4 py-2 text-base font-medium text-primary-foreground";
const thisYear = new Date().getUTCFullYear();

function CpaPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getCpaPortal);
  const q = useQuery({ queryKey: ["cpa-portal", user?.id], enabled: !!user, retry: false, queryFn: () => load() });
  const [tab, setTab] = useState<Tab>("ledger");
  const [year, setYear] = useState(thisYear - 1);
  const [pick, setPick] = useState(0);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/cpa/login" });
  }, [loading, user, navigate]);

  const d = q.data?.designations[pick];
  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-8 text-base text-foreground">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold sm:text-3xl">Designated CPA</h1>
          <p className="text-muted-foreground">Read-only. You can download statements and packets; nothing here can be changed.</p>
        </div>
        <button type="button" className={BTN} onClick={async () => { await supabase.auth.signOut(); navigate({ to: "/cpa/login" }); }}>
          Sign out
        </button>
      </header>
      {q.isLoading || loading ? <p className="text-muted-foreground">Loading…</p> : null}
      {q.isError ? <p className="text-destructive">{(q.error as Error).message}</p> : null}
      {q.data && q.data.designations.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-5">No LLC is designated to this login. If your designation was rescinded, your access has ended. Contact the Manager if this is unexpected.</p>
      ) : null}
      {q.data && d ? (
        <>
          <section className="rounded-xl border border-border bg-card p-4">
            {q.data.designations.length > 1 ? (
              <select className="mb-2 rounded-lg border border-border bg-background px-3 py-2" value={pick} onChange={(e) => setPick(Number(e.target.value))}>
                {q.data.designations.map((x, i) => (
                  <option key={x.propertyId} value={i}>
                    {x.llcName ?? x.property}
                  </option>
                ))}
              </select>
            ) : null}
            <p className="font-medium">{d.llcName ?? "LLC"}</p>
            <p className="text-muted-foreground">
              {d.property} · Designated: {d.cpaName}, {d.firm}
            </p>
          </section>
          <nav className="flex flex-wrap gap-2" aria-label="Sections">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? ON : BTN} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
          {tab === "ledger" || tab === "capital" ? (
            <label className="block text-sm font-medium">
              Year
              <input type="number" className="ml-2 w-28 rounded-lg border border-border bg-background px-3 py-2" value={year} onChange={(e) => setYear(Number(e.target.value))} />
            </label>
          ) : null}
          {tab === "ledger" ? <LedgerTab propertyId={d.propertyId} year={year} /> : null}
          {tab === "capital" ? <CapitalTab propertyId={d.propertyId} year={year} /> : null}
          {tab === "statements" ? <StatementsTab propertyId={d.propertyId} /> : null}
          {tab === "members" ? <MembersTab propertyId={d.propertyId} /> : null}
          {tab === "worksheet" ? <WorksheetTab propertyId={d.propertyId} /> : null}
          {tab === "packets" ? <PacketsTab propertyId={d.propertyId} /> : null}
        </>
      ) : null}
    </main>
  );
}

function Problem({ error }: { error: unknown }) {
  return <p className="text-destructive">{(error as Error).message}</p>;
}

function LedgerTab({ propertyId, year }: { propertyId: string; year: number }) {
  const load = useServerFn(getCpaLedger);
  const q = useQuery({ queryKey: ["cpa-ledger", propertyId, year], queryFn: () => load({ data: { propertyId, year } }), retry: false });
  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (q.error) return <Problem error={q.error} />;
  const l = q.data!;
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">
        {l.entries.length} entries in {l.year}. Debits {formatCents(l.totals.debitCents)} · Credits {formatCents(l.totals.creditCents)}.
      </p>
      {l.entries.map((e) => (
        <section key={e.id} className="rounded-xl border border-border bg-card p-4">
          <p className="font-medium">
            {e.date} · {e.memo || e.source}
            {e.reversal ? " (reversal)" : ""}
            {e.adjustment ? " (adjustment)" : ""}
          </p>
          <ul className="mt-1 space-y-1">
            {e.lines.map((x, i) => (
              <li key={i} className="flex justify-between gap-3 text-muted-foreground">
                <span className="min-w-0 break-words">
                  {x.code} {x.account}
                  {x.member ? `: ${x.member}` : ""}
                </span>
                <span className="shrink-0">{x.debitCents ? `Dr ${formatCents(x.debitCents)}` : `Cr ${formatCents(x.creditCents)}`}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function CapitalTab({ propertyId, year }: { propertyId: string; year: number }) {
  const load = useServerFn(getCpaCapitalAccounts);
  const q = useQuery({ queryKey: ["cpa-capital", propertyId, year], queryFn: () => load({ data: { propertyId, year } }), retry: false });
  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (q.error) return <Problem error={q.error} />;
  return (
    <div className="space-y-3">
      {q.data!.members.length === 0 ? <p className="text-muted-foreground">No capital account activity for {year}.</p> : null}
      {q.data!.members.map((m) => (
        <section key={m.memberKey} className="rounded-xl border border-border bg-card p-4">
          <h3 className="font-semibold">{m.name}</h3>
          <dl className="mt-1 space-y-1">
            {(
              [
                ["Beginning", m.beginningCents],
                ["Contributions", m.contributionsCents],
                ["Allocable income", m.incomeCents],
                ["Allocable expense", m.expenseCents],
                ["Allocable depreciation", m.depreciationCents],
                ["Distributions", m.distributionsCents],
                ["Ending", m.endingCents],
              ] as Array<[string, number]>
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt>{k}</dt>
                <dd>{formatCents(v)}</dd>
              </div>
            ))}
          </dl>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {m.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>
                  {l.date} · {CAPITAL_TYPE_LABELS[l.type] ?? l.type}
                </span>
                <span>
                  {formatCents(l.amountCents)} → {formatCents(l.balanceCents)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function StatementsTab({ propertyId }: { propertyId: string }) {
  const load = useServerFn(getCpaStatements);
  const read = useServerFn(getCpaStatement);
  const pdf = useServerFn(getCpaStatementPdf);
  const q = useQuery({ queryKey: ["cpa-statements", propertyId], queryFn: () => load({ data: { propertyId } }), retry: false });
  const [open, setOpen] = useState<string | null>(null);
  const one = useQuery({ queryKey: ["cpa-statement", open], enabled: !!open, queryFn: () => read({ data: { statementId: open! } }), retry: false });
  const download = async (statementId: string) => {
    try {
      const f = await pdf({ data: { statementId } });
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = f.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (q.error) return <Problem error={q.error} />;
  return (
    <div className="space-y-3">
      {q.data!.statements.length === 0 ? <p className="text-muted-foreground">No statements have been issued yet.</p> : null}
      {q.data!.statements.map((s) => (
        <section key={s.id} className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap justify-between gap-2">
            <span className="font-medium">
              {periodLabel(s.period)} · {s.member} · version {s.version}
            </span>
            <span>Closing {formatCents(s.closingCents)}</span>
          </div>
          <p className="text-sm text-muted-foreground">{STATEMENT_STATUS_LABELS[s.status as StatementStatus]}</p>
          <div className="mt-2 flex gap-3">
            <button type="button" className={BTN} onClick={() => setOpen(open === s.id ? null : s.id)}>
              {open === s.id ? "Hide" : "Read"}
            </button>
            <button type="button" className={BTN} onClick={() => download(s.id)}>
              Download the PDF
            </button>
          </div>
          {open === s.id && one.data ? (
            <div className="mt-4">
              <StatementView snapshot={one.data.snapshot} holder={one.data.holder} version={one.data.version} status={one.data.status} issuedAt={one.data.issuedAt} />
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function MembersTab({ propertyId }: { propertyId: string }) {
  const load = useServerFn(getCpaRoster);
  const reveal = useServerFn(revealCpaTinFn);
  const q = useQuery({ queryKey: ["cpa-roster", propertyId], queryFn: () => load({ data: { propertyId } }), retry: false });
  const [shown, setShown] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: (w9Id: string) => reveal({ data: { propertyId, w9Id } }),
    onSuccess: (r, w9Id) => setShown((s) => ({ ...s, [w9Id]: r.tin })),
    onError: (e: Error) => toast.error(e.message),
  });
  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (q.error) return <Problem error={q.error} />;
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">A TIN is shown only for K-1 preparation. Every view is recorded in the Audit Vault with the time and this LLC. It is not stored in your browser after you leave this page.</p>
      {q.data!.members.map((x) => (
        <section key={x.w9Id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
          <span>
            {x.legalName} <span className="text-muted-foreground">({x.tinKind.toUpperCase()})</span>
          </span>
          {shown[x.w9Id] ? (
            <span className="font-mono">{shown[x.w9Id]}</span>
          ) : (
            <button type="button" className={BTN} disabled={m.isPending} onClick={() => m.mutate(x.w9Id)}>
              Show TIN (logged)
            </button>
          )}
        </section>
      ))}
    </div>
  );
}

function WorksheetTab({ propertyId }: { propertyId: string }) {
  const load = useServerFn(getCpaWorksheet);
  const q = useQuery({ queryKey: ["cpa-worksheet", propertyId], queryFn: () => load({ data: { propertyId } }), retry: false });
  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (q.error) return <Problem error={q.error} />;
  const { flags, items } = q.data!;
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">Items the Manager has flagged for you. They are flags only: the platform computes no depreciation and no Section 754 step-up.</p>
      {flags.length + items.length === 0 ? <p className="text-muted-foreground">Nothing is flagged.</p> : null}
      {flags.map((f) => (
        <section key={f.id} className="rounded-xl border border-border bg-card p-4">
          <p className="font-medium">{f.type.replace(/_/g, " ")}</p>
          {f.note ? <p className="text-muted-foreground">{f.note}</p> : null}
        </section>
      ))}
      {items.map((i) => (
        <section key={i.id} className="rounded-xl border border-border bg-card p-4">
          <p className="font-medium">{i.kind.replace(/_/g, " ")}</p>
          {i.note ? <p className="text-muted-foreground">{i.note}</p> : null}
        </section>
      ))}
    </div>
  );
}

function PacketsTab({ propertyId }: { propertyId: string }) {
  const load = useServerFn(getCpaPackets);
  const q = useQuery({ queryKey: ["cpa-packets", propertyId], queryFn: () => load({ data: { propertyId } }), retry: false });
  if (q.isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (q.error) return <Problem error={q.error} />;
  return (
    <div className="space-y-3">
      {q.data!.packets.length === 0 ? <p className="text-muted-foreground">No Year-End Export Packet has been generated for this LLC yet.</p> : null}
      {q.data!.packets.map((p) => (
        <section key={p.id} className="rounded-xl border border-border bg-card p-4">
          <p className="font-medium">
            {p.year} · version {p.version}
          </p>
          <p className="text-sm text-muted-foreground">Hash {p.hash.slice(0, 16)}…</p>
        </section>
      ))}
    </div>
  );
}
