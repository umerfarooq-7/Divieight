import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { TermsDiffView } from "@/components/TermsDiffView";
import { getTermsAdminBoard, publishTerms, resendTermsNotices } from "@/lib/tc.functions";
import { diffPath, publishProblem, today } from "@/lib/tc";

export const Route = createFileRoute("/admin/terms")({
  head: () => ({ meta: [{ title: "Terms and Conditions — Manager" }, { name: "robots", content: "noindex" }] }),
  component: AdminTerms,
});

function nextVersion(latest: string | undefined) {
  const [maj, min] = (latest ?? "1.0").split(".").map((n) => Number(n) || 0);
  return `${maj}.${(min ?? 0) + 1}`;
}

function AdminTerms() {
  const qc = useQueryClient();
  const load = useServerFn(getTermsAdminBoard);
  const publish = useServerFn(publishTerms);
  const resend = useServerFn(resendTermsNotices);
  const { data, isLoading, error } = useQuery({ queryKey: ["admin-terms"], queryFn: () => load(), retry: false });

  const current = data?.versions.find((v) => v.is_current) ?? null;
  const [version, setVersion] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [body, setBody] = useState<string | null>(null);
  const [isMaterial, setIsMaterial] = useState(true);
  const [summary, setSummary] = useState("");

  const text = body ?? current?.body ?? "";
  const ver = version || nextVersion(current?.version);
  const input = { version: ver, effectiveDate, body: text, isMaterial, summary };
  const problem = useMemo(() => (data ? publishProblem(input, data.versions, today()) : "Loading…"), [data, ver, effectiveDate, text, isMaterial, summary]); // eslint-disable-line react-hooks/exhaustive-deps

  const publishMut = useMutation({
    mutationFn: () => publish({ data: input }),
    onSuccess: (r) => {
      toast.success(r.notices ? `Version ${r.version} published. Told ${r.notices.notified} of ${r.notices.recipients} people.` : `Version ${r.version} published. Nobody was notified: it is not a material change.`);
      setBody(null);
      setVersion("");
      setSummary("");
      setEffectiveDate("");
      void qc.invalidateQueries({ queryKey: ["admin-terms"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const resendMut = useMutation({
    mutationFn: (versionId: string) => resend({ data: { versionId } }),
    onSuccess: (r) => {
      toast.success(`Sent to ${r.notified} more. ${r.skipped} had already been told.`);
      void qc.invalidateQueries({ queryKey: ["admin-terms"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const field = "mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="font-display text-2xl font-semibold text-foreground">Terms and Conditions</h1>
      <p className="mt-1 text-base text-muted-foreground">
        Publish a new version. A <strong>material</strong> revision needs a summary of changes and notifies every user, once, in the app and by email, with a link to a marked comparison. A non-material edit is published and readable but
        notifies no one. Published versions are never edited.
      </p>

      {isLoading ? <p className="mt-6 text-base text-muted-foreground">Loading…</p> : null}
      {error ? <p className="mt-6 text-base text-destructive">{(error as Error).message}</p> : null}

      {data ? (
        <>
          <section className="mt-6 rounded-xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold text-foreground">Publish a version</h2>
            <p className="mt-1 text-sm text-muted-foreground">The text starts from the current version ({current?.version}). Edit it below.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block text-sm font-medium text-foreground">
                Version
                <input value={ver} onChange={(e) => setVersion(e.target.value)} className={field} />
              </label>
              <label className="block text-sm font-medium text-foreground">
                Effective date
                <input type="date" min={today()} value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} className={field} />
              </label>
            </div>
            <label className="mt-4 flex items-start gap-3 text-base text-foreground">
              <input type="checkbox" checked={isMaterial} onChange={(e) => setIsMaterial(e.target.checked)} className="mt-1 h-5 w-5" />
              <span>
                <strong>Material revision.</strong> Everyone is notified (in the app and by email).
              </span>
            </label>
            {isMaterial ? (
              <label className="mt-4 block text-sm font-medium text-foreground">
                Summary of changes (sent to every user)
                <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} className={field} />
              </label>
            ) : null}
            <label className="mt-4 block text-sm font-medium text-foreground">
              Terms text
              <textarea value={text} onChange={(e) => setBody(e.target.value)} rows={14} className={`${field} font-mono text-sm`} />
            </label>

            {current && text.trim() && text.trim() !== current.body.trim() ? (
              <div className="mt-5">
                <h3 className="text-base font-semibold text-foreground">What users will see compared with version {current.version}</h3>
                <div className="mt-2">
                  <TermsDiffView fromVersion={current.version} toVersion={ver} previous={current.body} next={text} />
                </div>
              </div>
            ) : null}

            {problem && effectiveDate ? <p role="alert" className="mt-4 text-base text-destructive">{problem}</p> : null}
            <button
              type="button"
              disabled={!!problem || publishMut.isPending}
              onClick={() => {
                if (!isMaterial || window.confirm(`Publish version ${ver} and notify every user?`)) publishMut.mutate();
              }}
              className="mt-5 inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {publishMut.isPending ? "Publishing…" : isMaterial ? "Publish and notify everyone" : "Publish (no notification)"}
            </button>
          </section>

          <section className="mt-8">
            <h2 className="font-display text-lg font-semibold text-foreground">Versions</h2>
            <ul className="mt-3 space-y-3">
              {data.versions.map((v, i) => {
                const rep = data.reports[v.id];
                const older = data.versions[i + 1];
                return (
                  <li key={v.id} className="rounded-xl border border-border bg-card p-4 text-base">
                    <p className="font-medium text-foreground">
                      Version {v.version}
                      {v.is_current ? " · current" : ""} <span className="font-normal text-muted-foreground">· effective {v.effective_date}{v.is_material ? " · material" : " · not material"}</span>
                    </p>
                    {v.summary_of_changes ? <p className="mt-1 text-muted-foreground">{v.summary_of_changes}</p> : null}
                    <p className="mt-1 flex flex-wrap gap-4 text-sm">
                      <a href={`/terms?v=${encodeURIComponent(v.version)}`} className="font-medium text-primary underline">Read</a>
                      {older ? <a href={diffPath(older.version, v.version)} className="font-medium text-primary underline">What changed</a> : null}
                    </p>
                    {rep ? (
                      <div className="mt-3 rounded-md bg-muted/50 p-3 text-sm text-foreground">
                        <p>
                          Told in the app: <strong>{rep.portalDelivered}</strong> of {rep.recipients} · email delivered: <strong>{rep.emailDelivered}</strong> · email not delivered: {rep.emailNotDelivered} · not yet notified:{" "}
                          <strong>{rep.notYetNotified}</strong>
                        </p>
                        {rep.notYetNotified > 0 ? (
                          <button type="button" disabled={resendMut.isPending} onClick={() => resendMut.mutate(v.id)} className="mt-2 inline-flex h-10 items-center rounded-md border border-border bg-background px-4 text-sm font-medium hover:bg-muted">
                            Send to those not yet told
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
