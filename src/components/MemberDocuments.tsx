import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download, FileText, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { getMyExecutedCopy, listMyExecutedDocuments } from "@/lib/document-access.functions";
import { auditRefLabel, type ExecutedDoc } from "@/lib/document-access";
import { downloadFileName } from "@/lib/document-reader";
import { renderTextPdf } from "@/lib/simple-pdf";

type Role = "buyer" | "seller" | "professional";

/**
 * The Member Documents area: every executed document with its title, the version executed, when, who signed, a PDF of the executed copy, its hash and the
 * Audit Vault entry that records it. The copy is the text kept at execution; it is never rebuilt from a template, so a later template revision cannot change it.
 */
export function MemberDocuments({ role }: { role: Role }) {
  const list = useServerFn(listMyExecutedDocuments);
  const copy = useServerFn(getMyExecutedCopy);
  const { data, isLoading, error } = useQuery({ queryKey: ["executed-documents", role], queryFn: () => list({ data: { role } }), retry: false });
  const [busy, setBusy] = useState<string | null>(null);

  async function download(d: ExecutedDoc) {
    setBusy(d.id);
    try {
      const c = await copy({ data: { role, id: d.id } });
      const header = [
        c.doc.title,
        `Version executed: ${c.doc.version}`,
        `Executed: ${new Date(c.doc.executedAt).toLocaleString()}`,
        `Signed by: ${c.doc.signers.map((s) => s.name).filter(Boolean).join(", ") || "n/a"}`,
        `Document hash: ${c.doc.hash ?? ""}`,
        `Text SHA-256: ${c.textSha256}`,
        c.doc.auditRef ? `Audit Vault reference: ${auditRefLabel(c.doc.auditRef.id)} (${c.doc.auditRef.id})` : "Audit Vault reference: not found",
        "EXECUTED COPY: this is the exact text that was signed. It is never edited or replaced.",
        "",
        "",
      ].join("\n");
      const bytes = renderTextPdf(header + c.text, `${c.doc.title} (executed)`);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadFileName(`${c.doc.title} executed`, c.doc.version);
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The executed copy could not be downloaded.");
    } finally {
      setBusy(null);
    }
  }

  const docs = data?.documents ?? [];
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {isLoading ? (
        <p className="px-6 py-10 text-center text-base text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="px-6 py-10 text-center text-base text-destructive">Your documents could not be loaded. Try again in a moment.</p>
      ) : docs.length === 0 ? (
        <p className="px-6 py-10 text-center text-base text-muted-foreground">You have not executed any documents yet.</p>
      ) : (
        <ul>
          {docs.map((d) => (
            <li key={d.id} className="flex flex-col gap-3 border-b border-border/60 px-5 py-4 last:border-0 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <span aria-hidden className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <FileText className="h-4 w-4" />
                </span>
                <div className="min-w-0 text-sm">
                  <p className="text-base font-medium text-foreground">{d.title}</p>
                  <p className="text-muted-foreground">
                    Version executed: <span className="font-medium text-foreground">{d.version || "n/a"}</span> · executed {new Date(d.executedAt).toLocaleString()}
                  </p>
                  <p className="text-muted-foreground">
                    Signed by:{" "}
                    {d.signers.length
                      ? d.signers.map((s, i) => (
                          <span key={i}>
                            {i ? "; " : ""}
                            <span className="font-medium text-foreground">{s.name || "(name on file)"}</span>
                            {s.note ? ` (${s.note})` : ""}
                          </span>
                        ))
                      : "n/a"}
                  </p>
                  {d.hash ? <p className="mt-1 break-all font-mono text-xs text-muted-foreground">Document hash: {d.hash}</p> : null}
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
                    <ShieldCheck aria-hidden className="h-4 w-4" />
                    {d.auditRef ? (
                      <span>
                        Audit Vault reference: <span className="font-mono font-medium text-foreground">{auditRefLabel(d.auditRef.id)}</span> <span className="text-xs">({d.auditRef.action}, {new Date(d.auditRef.at).toLocaleString()})</span>
                      </span>
                    ) : (
                      <span>Audit Vault reference: none found for this execution.</span>
                    )}
                  </p>
                  {d.copyNote ? <p className="mt-1 text-xs text-muted-foreground">{d.copyNote}</p> : null}
                </div>
              </div>
              <button
                type="button"
                disabled={!d.copyAvailable || busy === d.id}
                onClick={() => download(d)}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-1 rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download aria-hidden className="h-4 w-4" /> {busy === d.id ? "Preparing…" : "Download executed PDF"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
