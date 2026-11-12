import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2, CalendarDays, Lock } from "lucide-react";
import { getOwnerStr } from "@/lib/str.functions";
import { formatDate } from "@/lib/format-date";
import { OWNER_LLC_LINKS, OWNER_SECTIONS } from "@/lib/owner-sections";
import type { OwnerPropertyDetail } from "@/lib/owner.functions";
import { OverduePaymentNotice } from "@/components/owner/PaymentBits";
import {
  OwnerLoading,
  OwnerPageShell,
  OwnershipPendingNotice,
  useOwnerProperty,
} from "@/components/owner/useOwnerProperty";

export const Route = createFileRoute("/owner/properties/$propertyId/")({
  head: () => ({
    meta: [
      { title: "Owner dashboard — divieight" },
      { name: "description", content: "Your shares, capital account and calendar for this home." },
      { property: "og:title", content: "Owner dashboard — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerPropertyPage,
});

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const EIN_LABELS: Record<string, string> = { pending: "Pending", issued: "Issued", verified: "Verified" };

function OwnerPropertyPage() {
  const { propertyId } = Route.useParams();
  const { data, isLoading, isError, refetch } = useOwnerProperty(propertyId);

  return (
    <OwnerPageShell>
      <Link to="/owner" className="text-sm text-muted-foreground hover:text-foreground">
        ← My properties
      </Link>
      <div className="mt-4">
        <OverduePaymentNotice propertyId={propertyId} />
        {isLoading || !data || data.access === "none" ? (
          isError ? (
            <p className="text-sm text-muted-foreground">
              We couldn't load this property.{" "}
              <button type="button" onClick={() => void refetch()} className="font-medium text-primary hover:underline">
                Try again
              </button>
            </p>
          ) : (
            <OwnerLoading />
          )
        ) : data.access === "inactive" ? (
          <OwnershipPendingNotice label={data.property.label} propertyId={propertyId} />
        ) : (
          <Dashboard property={data.property} />
        )}
      </div>
    </OwnerPageShell>
  );
}

function Dashboard({ property: p }: { property: OwnerPropertyDetail }) {
  const locked = p.retentionLockExpiresAt && new Date(p.retentionLockExpiresAt).getTime() > Date.now();
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Owner dashboard</p>
          <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">{p.label}</h1>
        </div>
        {locked ? (
          <Link
            to="/owner/properties/$propertyId/retention"
            params={{ propertyId: p.propertyId }}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground hover:bg-secondary"
          >
            <Lock className="h-3.5 w-3.5 text-accent" aria-hidden />
            Resale locked until {formatDate(p.retentionLockExpiresAt)}
          </Link>
        ) : null}
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card title="Property overview">
          {p.photo ? (
            <img src={p.photo} alt="" className="mb-3 h-40 w-full rounded-lg object-cover" />
          ) : (
            <div className="mb-3 flex h-40 items-center justify-center rounded-lg bg-muted">
              <Building2 className="h-8 w-8 text-muted-foreground" aria-hidden />
            </div>
          )}
          <Facts
            rows={[
              ["Market", p.market || "—"],
              ["LLC", p.llcName ?? "—"],
              ["EIN status", p.einStatus ? (EIN_LABELS[p.einStatus] ?? p.einStatus) : "—"],
            ]}
          />
        </Card>

        <Card title="My shares">
          <p className="font-display text-3xl font-semibold text-foreground">{p.shareCount} of 8</p>
          <div className="mt-3">
            <Facts
              rows={[
                [`Share number${p.shareNumbers.length === 1 ? "" : "s"}`, p.shareNumbers.join(", ")],
                ["Acquired", formatDate(p.acquisitionDate)],
              ]}
            />
          </div>
          {p.shareLabels.length > 0 ? (
            <ul className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
              {p.shareLabels.map((s) => (
                <li key={s.shareNumber} className="flex flex-wrap justify-between gap-2">
                  <span className="text-muted-foreground">Share #{s.shareNumber}</span>
                  <span className="font-medium text-foreground">{s.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card title="Capital account">
          {p.capital ? (
            <Facts
              rows={[
                ["Contributed", money(p.capital.contributed)],
                ...(p.capital.contributions.length > 0
                  ? ([
                      ["  of which capital calls", money(p.capital.contributions.filter((c) => c.type === "capital_call").reduce((s, c) => s + c.amount, 0))],
                      ["  of which expenses", money(p.capital.contributions.filter((c) => c.type === "expense").reduce((s, c) => s + c.amount, 0))],
                    ] as Array<[string, string]>)
                  : []),
                ["Distributions", money(p.capital.distributions)],
                ["Net", money(p.capital.net)],
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No capital account activity yet.</p>
          )}
        </Card>

        <Card title="Use calendar">
          {p.upcomingStays.length > 0 ? (
            <ul className="space-y-1.5 text-sm">
              {p.upcomingStays.map((s) => (
                <li key={s.startDate} className="flex flex-wrap justify-between gap-2 text-foreground">
                  <span>Week {s.weekNumber}</span>
                  <span className="text-muted-foreground">
                    {formatDate(s.startDate)} to {formatDate(s.endDate)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No upcoming stays yet.</p>
          )}
          <Link
            to="/owner/properties/$propertyId/calendar"
            params={{ propertyId: p.propertyId }}
            className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <CalendarDays className="h-4 w-4" aria-hidden />
            Open calendar
          </Link>
        </Card>
      </div>

      <nav aria-label="Owner sections" className="mt-6 flex flex-wrap gap-2">
        {OWNER_LLC_LINKS.map((l) => (
          <Link
            key={l.tab}
            to="/owner/properties/$propertyId/llc"
            params={{ propertyId: p.propertyId }}
            search={{ tab: l.tab }}
            className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            {l.label}
          </Link>
        ))}
        <Link
          to="/owner/properties/$propertyId/votes"
          params={{ propertyId: p.propertyId }}
          className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Voting
        </Link>
        <Link
          to="/owner/properties/$propertyId/resale"
          params={{ propertyId: p.propertyId }}
          className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Resale Shop
        </Link>
        <Link
          to="/owner/properties/$propertyId/maintenance"
          params={{ propertyId: p.propertyId }}
          className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Maintenance
        </Link>
        <Link
          to="/owner/properties/$propertyId/expenses"
          params={{ propertyId: p.propertyId }}
          className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Expenses
        </Link>
        <Link
          to="/owner/properties/$propertyId/ledger"
          params={{ propertyId: p.propertyId }}
          className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Ledger
        </Link>
        <StrRecordsLink propertyId={p.propertyId} />
        <Link
          to="/owner/properties/$propertyId/capital"
          params={{ propertyId: p.propertyId }}
          className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Capital account
        </Link>
        <Link
          to="/owner/properties/$propertyId/capital-calls"
          params={{ propertyId: p.propertyId }}
          className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Capital calls
        </Link>
        <Link
          to="/owner/notifications"
          className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Notification settings
        </Link>
        {OWNER_SECTIONS.map((s) => (
          <Link
            key={s.slug}
            to="/owner/properties/$propertyId/$section"
            params={{ propertyId: p.propertyId, section: s.slug }}
            className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            {s.label}
          </Link>
        ))}
      </nav>
    </>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="space-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words font-medium text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Only a home whose intent profile includes short-term rental offers the tracker; for any other home the link is not shown.
function StrRecordsLink({ propertyId }: { propertyId: string }) {
  const load = useServerFn(getOwnerStr);
  const { data } = useQuery({ queryKey: ["owner-str", propertyId], retry: false, queryFn: () => load({ data: { propertyId } }) });
  if (!data?.trackerEnabled) return null;
  return (
    <Link
      to="/owner/properties/$propertyId/str"
      params={{ propertyId }}
      className="inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
    >
      Short-term rental records
    </Link>
  );
}
