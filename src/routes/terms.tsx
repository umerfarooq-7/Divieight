import { createFileRoute, Link } from "@tanstack/react-router";
import { DocumentReader } from "@/components/DocumentReader";
import { TERMS_EFFECTIVE, TERMS_TEXT, TERMS_TITLE, TERMS_VERSION } from "@/lib/terms";
import { hashDocument } from "@/lib/legal-documents";

/** Pre-Engagement: public, no login. Linked from the footer, the registration screens and the account menu. */
export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms and Conditions — divieight" },
      { name: "description", content: `The divieight Terms and Conditions, version ${TERMS_VERSION}, effective ${TERMS_EFFECTIVE}. Read them without an account.` },
      { property: "og:title", content: "Terms and Conditions — divieight" },
      { property: "og:type", content: "website" },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Pre-Engagement</p>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-foreground">{TERMS_TITLE}</h1>
      <p className="mt-2 text-base text-muted-foreground">
        Version {TERMS_VERSION} · effective {TERMS_EFFECTIVE}. You can read, search and download them without signing in.
      </p>
      <div className="mt-6">
        <DocumentReader
          title={TERMS_TITLE}
          version={TERMS_VERSION}
          effectiveDate={TERMS_EFFECTIVE}
          text={TERMS_TEXT}
          hash={hashDocument(TERMS_TEXT)}
          crossRefs={{ terms: true, pra: false }}
          heightClass="h-[70vh] min-h-[320px]"
        />
      </div>
      <p className="mt-6 text-sm text-muted-foreground">
        Questions? <Link to="/contact" className="font-medium text-primary underline">Contact us</Link>.
      </p>
    </div>
  );
}
