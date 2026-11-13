import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { TermsDiffView } from "@/components/TermsDiffView";
import { getTermsComparison } from "@/lib/tc.functions";

/** What changed between two versions of the Terms: public, no sign-in. The link in every change notice leads here. */
export const Route = createFileRoute("/terms-changes")({
  validateSearch: (search: Record<string, unknown>) => ({
    from: typeof search.from === "string" ? search.from : "",
    to: typeof search.to === "string" ? search.to : "",
  }),
  head: () => ({ meta: [{ title: "What changed in the Terms — divieight" }, { name: "description", content: "A side-by-side, marked comparison of two versions of the divieight Terms and Conditions." }] }),
  component: TermsChanges,
});

type Loaded = Awaited<ReturnType<typeof getTermsComparison>>;

function TermsChanges() {
  const { from, to } = Route.useSearch();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    getTermsComparison({ data: { from, to } })
      .then((r) => !cancelled && setData(r))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Terms and Conditions</p>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground">What changed</h1>
      {failed ? (
        <p className="mt-4 text-base text-muted-foreground">
          Those two versions could not be found. <Link to="/terms" search={{ v: undefined }} className="font-medium text-primary underline">See every version</Link>.
        </p>
      ) : !data ? (
        <div className="mt-6 h-64 animate-pulse rounded-xl border border-border bg-muted/40" />
      ) : (
        <>
          <p className="mt-2 text-base text-muted-foreground">
            Version {data.from.version} to version {data.to.version}, effective {data.to.effectiveDate}.
          </p>
          {data.to.summary ? (
            <div className="mt-4 rounded-lg border border-border bg-card p-4">
              <p className="text-sm font-semibold text-foreground">Summary of changes</p>
              <p className="mt-1 text-base text-foreground">{data.to.summary}</p>
              {data.to.isMaterial ? <p className="mt-2 text-sm text-muted-foreground">If you keep using divieight after {data.to.effectiveDate}, you accept version {data.to.version}. You do not need to sign anything.</p> : null}
            </div>
          ) : null}
          <div className="mt-6">
            <TermsDiffView fromVersion={data.from.version} toVersion={data.to.version} previous={data.from.body} next={data.to.body} />
          </div>
          <p className="mt-6 flex flex-wrap gap-4 text-base">
            <Link to="/terms" search={{ v: data.from.version }} className="font-medium text-primary underline">
              Read version {data.from.version}
            </Link>
            <Link to="/terms" search={{ v: data.to.version }} className="font-medium text-primary underline">
              Read version {data.to.version}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
