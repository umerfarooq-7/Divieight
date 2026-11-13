import { createFileRoute } from "@tanstack/react-router";
import { MemberDocuments } from "@/components/MemberDocuments";

/** Member Documents for professionals: every executed agreement, as executed. */
export const Route = createFileRoute("/agent/executed-documents")({
  head: () => ({ meta: [{ title: "Executed documents — divieight Professional Portal" }, { name: "robots", content: "noindex" }] }),
  component: AgentExecutedDocuments,
});

function AgentExecutedDocuments() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Professional</p>
      <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">Executed documents</h1>
      <p className="mt-1 text-base text-muted-foreground">Every agreement you have executed, exactly as signed. An executed document is never edited or replaced.</p>
      <div className="mt-6">
        <MemberDocuments role="professional" />
      </div>
    </div>
  );
}
