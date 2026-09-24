import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, ChevronDown, ChevronRight, XCircle } from "lucide-react";
import { listClosingReadiness } from "@/lib/closing-readiness.functions";
import type { Readiness } from "@/lib/closing-readiness.server";

export const Route = createFileRoute("/admin/closing-readiness")({
  head: () => ({
    meta: [
      { title: "Closing Readiness — divieight admin" },
      { name: "description", content: "Every pre-closing gate per property, at a glance." },
      { property: "og:title", content: "Closing Readiness — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ClosingReadinessPage,
});

function ClosingReadinessPage() {
  const load = useServerFn(listClosingReadiness);
  const { data, isLoading, refetch, isFetching } = useQuery({ queryKey: ["closing-readiness"], queryFn: () => load() });
  const props = data?.properties ?? [];
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-foreground">Closing Readiness</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Every gate a closing depends on, per property. Read-only — it pulls existing statuses together and changes
            nothing. Follow a red item's link to the screen where it's resolved.
          </p>
        </div>
        <button onClick={() => refetch()} disabled={isFetching} className="rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:opacity-50">
          {isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="mt-6 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Checking every gate…</p>
        ) : props.length === 0 ? (
          <p className="text-sm text-muted-foreground">No property has a live pod.</p>
        ) : (
          props.map((r) => <PropertyReadiness key={r.propertyId} r={r} />)
        )}
      </div>
    </div>
  );
}

function PropertyReadiness({ r }: { r: Readiness }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-display text-base font-semibold text-foreground">{r.label}</h2>
          <p className="text-xs text-muted-foreground">
            Pod {r.pod.retained} retained + {r.pod.reserved} reserved = {r.pod.total}/8 · listing {r.listingStatus ?? "—"}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${r.ready ? "bg-emerald-100 text-emerald-800" : "bg-destructive/10 text-destructive"}`}>
          {r.ready ? "Ready to close" : `${r.blocking} blocking`}
        </span>
      </div>
      <ul className="mt-4 divide-y divide-border">
        {r.items.map((i) => {
          const expandable = i.details.length > 0;
          return (
            <li key={i.key} className="py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <button
                  type="button"
                  disabled={!expandable}
                  onClick={() => setOpen((o) => ({ ...o, [i.key]: !o[i.key] }))}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left disabled:cursor-default"
                >
                  {i.ok ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />}
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 text-sm font-medium text-foreground">
                      {i.label}
                      {expandable ? open[i.key] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" /> : null}
                    </span>
                    <span className={`block text-xs ${i.ok ? "text-muted-foreground" : "text-destructive"}`}>{i.summary}</span>
                  </span>
                </button>
                {!i.ok ? (
                  <Link to={i.link as never} className="shrink-0 text-xs font-medium text-primary hover:underline">
                    Resolve →
                  </Link>
                ) : null}
              </div>
              {expandable && open[i.key] ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-12 text-xs text-muted-foreground">
                  {i.details.map((d, k) => (
                    <li key={k}>{d}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
