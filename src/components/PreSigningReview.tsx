import type { ReactNode } from "react";
import { DocumentReader } from "@/components/DocumentReader";
import type { CrossRefTargets } from "@/lib/document-reader";

/**
 * Pre-Signing Review: a platform-generated document shown on its own screen, distinct from the signing screen. Scroll, search, contents, text size and a downloadable
 * draft. Nothing is signed here; the button leads to the signing screen, which shows the exact text again with its stored hash.
 */
export function PreSigningReview({
  title,
  version,
  effectiveDate,
  text,
  hash,
  signHref,
  signLabel = "Continue to signing",
  intro,
  crossRefs = { terms: true, pra: false },
  signDisabledNote,
}: {
  title: string;
  version: string;
  effectiveDate?: string;
  text: string | null | undefined;
  hash?: string | null;
  signHref: string;
  signLabel?: string;
  intro?: ReactNode;
  crossRefs?: CrossRefTargets;
  signDisabledNote?: string;
}) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Pre-Signing Review</p>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="mt-2 text-base text-muted-foreground">
        {intro ?? "Read this document before you sign it. You can search it, jump to any section, enlarge the text and download a draft. Nothing is signed on this screen."}
      </p>
      {text ? (
        <div className="mt-6">
          <DocumentReader title={title} version={version} effectiveDate={effectiveDate} text={text} hash={hash} crossRefs={crossRefs} downloadNote="This is a draft for your review. It is signed on the signing screen." heightClass="h-[62vh] min-h-[300px]" />
        </div>
      ) : (
        <p className="mt-6 rounded-xl border border-dashed border-border p-10 text-center text-base text-muted-foreground">{signDisabledNote ?? "This document is not ready for review yet."}</p>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        <a href={signHref} className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {signLabel}
        </a>
        <button type="button" onClick={() => window.history.back()} className="inline-flex h-11 items-center justify-center rounded-md border border-border px-5 text-sm font-medium text-foreground hover:bg-muted">
          Back
        </button>
      </div>
    </div>
  );
}
