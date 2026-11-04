import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format-date";
import { getOwnerLlc, type OwnerLlcPayload } from "@/lib/owner-llc.functions";

const TABS = ["operating-agreement", "co-owners", "governance", "notices"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/owner/properties/$propertyId/llc")({
  head: () => ({
    meta: [
      { title: "LLC — divieight" },
      { name: "description", content: "Operating Agreement, co-owners, governance rules and notices for your home." },
      { property: "og:title", content: "LLC — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    TABS.includes(search.tab as Tab) ? { tab: search.tab as Tab } : {},
  component: OwnerLlcPage,
});

function OwnerLlcPage() {
  const { propertyId } = Route.useParams();
  const { tab } = Route.useSearch();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getOwnerLlc);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["owner-llc", propertyId, user?.id],
    enabled: !!user,
    retry: false,
    queryFn: () => load({ data: { propertyId } }),
  });
  const [active, setActive] = useState<Tab>(tab ?? "operating-agreement");

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/owner/login", search: { redirect: window.location.pathname } });
  }, [authLoading, user, navigate]);

  const denied = data?.access === "none";
  useEffect(() => {
    if (!denied) return;
    toast.error("You don't have ownership in that property.");
    navigate({ to: "/owner" });
  }, [denied, navigate]);

  return (
    <OwnerPageShell>
      <Link to="/owner/properties/$propertyId" params={{ propertyId }} className="text-sm text-muted-foreground hover:text-foreground">
        ← Owner dashboard
      </Link>
      {isError ? (
        <p className="mt-6 text-sm text-muted-foreground">
          We couldn't load this page.{" "}
          <button type="button" onClick={() => void refetch()} className="font-medium text-primary hover:underline">
            Try again
          </button>
        </p>
      ) : authLoading || isLoading || !data || data.access === "none" ? (
        <OwnerLoading />
      ) : (
        <>
          <p className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-accent">LLC</p>
          <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">{data.label}</h1>
          <Tabs value={active} onValueChange={(v) => setActive(v as Tab)} className="mt-6">
            <TabsList className="h-auto flex-wrap justify-start">
              <TabsTrigger value="operating-agreement">Operating Agreement</TabsTrigger>
              <TabsTrigger value="co-owners">Co-owners</TabsTrigger>
              <TabsTrigger value="governance">Governance rules</TabsTrigger>
              <TabsTrigger value="notices">Notices</TabsTrigger>
            </TabsList>
            <TabsContent value="operating-agreement" className="mt-4">
              <AgreementTab agreement={data.operatingAgreement} />
            </TabsContent>
            <TabsContent value="co-owners" className="mt-4">
              <RosterTab roster={data.roster} />
            </TabsContent>
            <TabsContent value="governance" className="mt-4">
              <RulesTab rules={data.rules} />
            </TabsContent>
            <TabsContent value="notices" className="mt-4">
              <NoticesTab notices={data.notices} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </OwnerPageShell>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{children}</p>;
}

function AgreementTab({ agreement }: { agreement: OwnerLlcPayload["operatingAgreement"] }) {
  if (!agreement) return <Empty>Not available yet</Empty>;
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 text-sm">
          <p className="text-foreground">Executed {formatDate(agreement.executedAt)}</p>
          {agreement.hash ? <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{agreement.hash}</p> : null}
        </div>
        {agreement.downloadUrl ? (
          <a
            href={agreement.downloadUrl}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-secondary"
          >
            <Download className="h-4 w-4" aria-hidden /> Download
          </a>
        ) : null}
      </div>
      {agreement.text ? (
        <pre tabIndex={0} className="mt-4 max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-4 text-xs leading-relaxed text-foreground">
          {agreement.text}
        </pre>
      ) : null}
    </section>
  );
}

function RosterTab({ roster }: { roster: OwnerLlcPayload["roster"] }) {
  if (!roster) return <Empty>The co-owner roster opens after closing.</Empty>;
  if (roster.length === 0) return <Empty>No co-owners are listed yet.</Empty>;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {roster.map((r) => (
        <li key={r.shareNumbers.join("-")} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {r.name}
              {r.isMe ? <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span> : null}
            </p>
            <p className="text-xs text-muted-foreground">
              {r.holderLabel} · Acquired {formatDate(r.acquisitionDate)}
            </p>
          </div>
          <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-medium text-accent">
            Share{r.shareNumbers.length === 1 ? "" : "s"} {r.shareNumbers.join(", ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RulesTab({ rules }: { rules: OwnerLlcPayload["rules"] }) {
  if (rules.length === 0) return <Empty>No governance rules have been published yet.</Empty>;
  return (
    <div className="space-y-3">
      {rules.map((r) => (
        <section key={r.id} className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground">{r.title}</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{r.body}</p>
        </section>
      ))}
      <p className="text-xs text-muted-foreground">
        This is a summary. If anything here differs from your executed Operating Agreement, the Operating Agreement controls.
      </p>
    </div>
  );
}

function NoticesTab({ notices }: { notices: OwnerLlcPayload["notices"] }) {
  if (notices.length === 0) return <Empty>No notices yet.</Empty>;
  return (
    <div className="space-y-3">
      {notices.map((n) => (
        <section key={n.id} className="rounded-xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">{n.title}</h2>
            <span className="text-xs text-muted-foreground">{formatDate(n.created_at)}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{n.body}</p>
        </section>
      ))}
    </div>
  );
}
