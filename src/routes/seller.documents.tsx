import { createFileRoute, Link } from "@tanstack/react-router";
import { MemberDocuments } from "@/components/MemberDocuments";

/** Member Documents for sellers: every executed document, as executed. */
export const Route = createFileRoute("/seller/documents")({
  head: () => ({ meta: [{ title: "My documents — divieight" }, { name: "robots", content: "noindex" }] }),
  component: SellerDocuments,
});

function SellerDocuments() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-8">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Seller</p>
      <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">My documents</h1>
      <p className="mt-1 text-base text-muted-foreground">Every document you have executed, exactly as you signed it. An executed document is never edited or replaced.</p>
      <div className="mt-6">
        <MemberDocuments role="seller" />
      </div>
      <Link to="/dashboard" className="mt-6 inline-block rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">
        Back to dashboard
      </Link>
    </div>
  );
}
