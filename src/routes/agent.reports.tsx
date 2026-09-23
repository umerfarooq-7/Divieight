import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { annotateReport, listAgentReports } from "@/lib/reports.functions";
import { ANNOTATION_NOTICE, formatReportDate } from "@/lib/reports";
import { ReportCard } from "@/components/ReportCard";

export const Route = createFileRoute("/agent/reports")({
  head: () => ({
    meta: [
      { title: "Buyer reports — divieight Professional Portal" },
      {
        name: "description",
        content: "Appraisal and inspection reports delivered to your tethered buyers, with your notes.",
      },
      { property: "og:title", content: "Buyer reports — divieight Professional Portal" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentReports,
});

function AgentReports() {
  const fetchRows = useServerFn(listAgentReports);
  const annotate = useServerFn(annotateReport);
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["agent-reports"],
    queryFn: () => fetchRows(),
  });
  const rows = data?.rows ?? [];

  const noteMut = useMutation({
    mutationFn: (v: { reportId: string; buyerAccountId: string; note: string }) =>
      annotate({ data: v }),
    onSuccess: (_r, v) => {
      toast.success("Note shared with your buyer.");
      setDrafts((d) => ({ ...d, [`${v.reportId}:${v.buyerAccountId}`]: "" }));
      void qc.invalidateQueries({ queryKey: ["agent-reports"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <h1 className="font-display text-xl font-semibold text-foreground">Appraisal & inspection reports</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Reports delivered to your tethered buyers, exactly as received. Each is a Required
        due-diligence document awaiting your parallel acknowledgment under Due diligence. Any notes
        you add are your own professional commentary and go only to that buyer.
      </p>

      <div className="mt-6 space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reports for your buyers yet.</p>
        ) : (
          rows.map((row) => {
            const key = `${row.report.id}:${row.buyerAccountId}`;
            return (
              <ReportCard
                key={key}
                report={row.report}
                signedUrl={row.report.signed_url}
                superseded={row.report.superseded}
                propertyLabel={`${row.report.propertyLabel} · buyer: ${row.buyerLabel}`}
              >
                <div className="mt-4 border-t border-border pt-3">
                  {row.annotations.length > 0 ? (
                    <ul className="mb-3 space-y-2">
                      {row.annotations.map((a) => (
                        <li key={a.id} className="rounded-lg bg-muted/40 p-3 text-sm text-foreground">
                          <p className="whitespace-pre-wrap">{a.note}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            You · {formatReportDate(a.created_at)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <textarea
                    value={drafts[key] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    rows={3}
                    placeholder="Add a note for this buyer (optional)"
                    className="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  />
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">{ANNOTATION_NOTICE}</p>
                    <button
                      type="button"
                      disabled={noteMut.isPending || !(drafts[key] ?? "").trim()}
                      onClick={() =>
                        noteMut.mutate({
                          reportId: row.report.id,
                          buyerAccountId: row.buyerAccountId,
                          note: drafts[key] ?? "",
                        })
                      }
                      className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    >
                      Share note
                    </button>
                  </div>
                </div>
              </ReportCard>
            );
          })
        )}
      </div>
    </div>
  );
}
