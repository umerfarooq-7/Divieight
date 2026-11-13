import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DocumentReader } from "@/components/DocumentReader";
import { getPublicTerms } from "@/lib/tc.functions";
import { TERMS_EFFECTIVE, TERMS_TEXT, TERMS_TITLE, TERMS_VERSION } from "@/lib/terms";
import { hashDocument } from "@/lib/legal-documents";
import { diffPath } from "@/lib/tc";

/** Pre-Engagement: public, no login. Linked from the footer, the registration screens and the account menu. Every version stays readable here. */
export const Route = createFileRoute("/terms")({
  validateSearch: (search: Record<string, unknown>): { v?: string } => (typeof search.v === "string" ? { v: search.v } : {}),
  head: () => ({
    meta: [
      { title: "Terms and Conditions — divieight" },
      { name: "description", content: "The divieight Terms and Conditions, every version, and what changed between them. Read them without an account." },
      { property: "og:title", content: "Terms and Conditions — divieight" },
      { property: "og:type", content: "website" },
    ],
  }),
  component: TermsPage,
});

type Loaded = Awaited<ReturnType<typeof getPublicTerms>>;

function TermsPage() {
  const { v } = Route.useSearch();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getPublicTerms({ data: { version: v ?? null } })
      .then((r) => !cancelled && setData(r))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [v]);

  // If the versions cannot be read, the Terms as first published are still shown.
  const shown = data?.shown ?? (failed ? { version: TERMS_VERSION, effective_date: TERMS_EFFECTIVE, body: TERMS_TEXT } : null);
  const old = !!data && !!shown && shown.version !== data.inForceVersion && shown.version !== data.upcoming?.version;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Pre-Engagement</p>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground">{TERMS_TITLE}</h1>
      {shown ? (
        <p className="mt-2 text-base text-muted-foreground">
          Version {shown.version} · effective {shown.effective_date}. You can read, search and download them without signing in.
        </p>
      ) : null}

      {data?.upcoming && data.upcoming.version !== shown?.version ? (
        <p role="status" className="mt-4 rounded-lg border border-border bg-muted/50 p-3 text-base text-foreground">
          Version {data.upcoming.version} takes effect on {data.upcoming.effectiveDate}.{" "}
          <Link to="/terms" search={{ v: data.upcoming.version }} className="font-medium text-primary underline">
            Read it
          </Link>{" "}
          {data.inForceVersion ? (
            <>
              or{" "}
              <a href={diffPath(data.inForceVersion, data.upcoming.version)} className="font-medium text-primary underline">
                see what changes
              </a>
              .
            </>
          ) : null}
        </p>
      ) : null}
      {old ? (
        <p role="status" className="mt-4 rounded-lg border border-border bg-muted/50 p-3 text-base text-foreground">
          You are reading version {shown!.version}, which is not the version in force. Version {data!.inForceVersion} is.{" "}
          <Link to="/terms" search={{ v: undefined }} className="font-medium text-primary underline">
            Read the version in force
          </Link>
          .
        </p>
      ) : null}

      <div className="mt-6">
        {shown ? (
          <DocumentReader
            title={TERMS_TITLE}
            version={shown.version}
            effectiveDate={shown.effective_date}
            text={shown.body}
            hash={hashDocument(shown.body)}
            crossRefs={{ terms: true, pra: false }}
            heightClass="h-[70vh] min-h-[320px]"
          />
        ) : (
          <div className="h-64 animate-pulse rounded-xl border border-border bg-muted/40" />
        )}
      </div>

      {data ? (
        <section className="mt-8" aria-label="Version history">
          <h2 className="font-display text-xl font-semibold text-foreground">Every version</h2>
          <p className="mt-1 text-sm text-muted-foreground">Earlier versions stay here. A version is never edited once published.</p>
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-card">
            {data.history.map((h, i) => {
              const older = data.history[i + 1];
              return (
                <li key={h.version} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-base">
                  <span>
                    <Link to="/terms" search={{ v: h.version }} className="font-medium text-primary underline">
                      Version {h.version}
                    </Link>{" "}
                    <span className="text-muted-foreground">
                      · effective {h.effectiveDate}
                      {h.inForce ? " · in force" : h.effectiveDate > new Date().toISOString().slice(0, 10) ? " · upcoming" : ""}
                      {h.isMaterial ? " · material change" : ""}
                    </span>
                    {h.summary ? <span className="block text-sm text-muted-foreground">{h.summary}</span> : null}
                  </span>
                  {older ? (
                    <a href={diffPath(older.version, h.version)} className="text-sm font-medium text-primary underline">
                      What changed
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <p className="mt-6 text-sm text-muted-foreground">
        Questions? <Link to="/contact" className="font-medium text-primary underline">Contact us</Link>.
      </p>
    </div>
  );
}
