import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { MessageSquareText } from "lucide-react";
import { listBuyerReports } from "@/lib/reports.functions";
import { ANNOTATION_NOTICE, DELIVERY_NOTICE, formatReportDate } from "@/lib/reports";
import { ReportCard } from "@/components/ReportCard";

export const Route = createFileRoute("/buyer/reports")({
  head: () => ({
    meta: [
      { title: "Appraisal & inspection reports — divieight" },
      {
        name: "description",
        content: "Appraisal and inspection reports for the homes you've reserved, delivered as received.",
      },
      { property: "og:title", content: "Appraisal & inspection reports — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BuyerReports,
});

function BuyerReports() {
  const fetchReports = useServerFn(listBuyerReports);
  const { data, isLoading } = useQuery({
    queryKey: ["buyer-reports"],
    queryFn: () => fetchReports(),
  });
  const reports = data?.reports ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-foreground">
          Appraisal & inspection reports
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{DELIVERY_NOTICE}</p>
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading your reports…</p>
      ) : reports.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
          No reports have been delivered for your reserved homes yet. You'll be notified as soon as one
          arrives.
        </p>
      ) : (
        <div className="space-y-4">
          {reports.map((r) => (
            <ReportCard
              key={r.id}
              report={r}
              signedUrl={r.signed_url}
              superseded={r.superseded}
              propertyLabel={r.propertyLabel}
            >
              {!r.superseded ? (
                <Link
                  to="/buyer/due-diligence/$id"
                  params={{ id: r.property_id }}
                  className="mt-3 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  Acknowledge in due diligence →
                </Link>
              ) : null}

              {r.annotations.length > 0 ? (
                <div className="mt-4 border-t border-border pt-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                    <MessageSquareText className="h-3.5 w-3.5" /> Notes from your Resident Agent
                  </p>
                  <ul className="mt-2 space-y-2">
                    {r.annotations.map((a) => (
                      <li key={a.id} className="rounded-lg bg-muted/40 p-3 text-sm text-foreground">
                        <p className="whitespace-pre-wrap">{a.note}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {a.agent_name ?? "Resident Agent"} · {formatReportDate(a.created_at)}
                        </p>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">{ANNOTATION_NOTICE}</p>
                </div>
              ) : null}
            </ReportCard>
          ))}
        </div>
      )}
    </div>
  );
}
