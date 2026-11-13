import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, FileText, Landmark } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listMyPropertyRecords } from "@/lib/ownership.functions";
import { MemberDocuments } from "@/components/MemberDocuments";
import { BLOCK_5_TEXT } from "@/components/Block5AdviceNotice";

export const Route = createFileRoute("/buyer/documents")({
  head: () => ({
    meta: [
      { title: "My documents — divieight" },
      {
        name: "description",
        content: "Every agreement you've signed, and each co-owned property's Records Vault.",
      },
      { property: "og:title", content: "My documents — divieight" },
      {
        property: "og:description",
        content: "Every agreement you've signed on your divieight Buyer Account.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BuyerDocumentsPage,
});

function BuyerDocumentsPage() {
  const loadRecords = useServerFn(listMyPropertyRecords);
  const { data: records } = useQuery({ queryKey: ["my-property-records"], queryFn: () => loadRecords(), retry: false });
  const owned = records?.properties ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
        {owned.length ? "Co-owner" : "Buyer Account"}
      </p>
      <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">
        My documents
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Every document you have executed, exactly as you signed it, with the version, who signed, its hash and its Audit Vault reference. An executed document is never edited or replaced.
      </p>

      <div className="mt-6">
        <MemberDocuments role="buyer" />
      </div>

      <div className="mt-6 rounded-xl border border-border bg-card p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">
          Block 5 · Independent professional advice
        </p>
        <p className="mt-3 text-sm leading-relaxed text-foreground/90">{BLOCK_5_TEXT}</p>
      </div>

      {owned.map((prop) => (
        <section key={prop.propertyId} className="mt-8">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            <Landmark className="h-3.5 w-3.5" /> Property Records Vault
          </p>
          <h2 className="font-display text-xl font-semibold text-foreground">{prop.label}</h2>
          <p className="text-sm text-muted-foreground">
            {prop.llcName ?? "Property LLC"} · you hold {prop.shares} of 8 shares · co-owner since{" "}
            {new Date(prop.since).toLocaleDateString()}. These records stay here for as long as you own your share.
          </p>
          <div className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
            {prop.documents.length === 0 ? (
              <p className="px-6 py-8 text-center text-sm text-muted-foreground">No records stored yet.</p>
            ) : (
              prop.documents.map((d) => (
                <div key={d.id} className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4 last:border-0">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <FileText className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{d.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {d.title ?? ""} · stored {new Date(d.storedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                      Open <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>
      ))}

      <Link
        to="/buyer/dashboard"
        className="mt-6 inline-block rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
