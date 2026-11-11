import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { PUBLISH_WARNING, standardDocumentName } from "@/lib/standard-version";
import { listStandardVersionsFn, publishStandardVersionFn } from "@/lib/standard-version.functions";
import { when } from "@/lib/admin";

export const Route = createFileRoute("/admin/standard")({
  head: () => ({ meta: [{ title: "Participant Eligibility Standard — divieight admin" }] }),
  component: StandardPage,
});

/**
 * The Participant Eligibility Standard as a versioned document. Exactly one version is live. Publishing a
 * new one makes it the live version for declarations made from then on; nobody who has already declared is
 * re-measured.
 */
function StandardPage() {
  const qc = useQueryClient();
  const load = useServerFn(listStandardVersionsFn);
  const publish = useServerFn(publishStandardVersionFn);
  const { data, isLoading, error } = useQuery({ queryKey: ["admin-standard"], retry: false, queryFn: () => load() });
  const [version, setVersion] = useState("");
  const [fileUrl, setFileUrl] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const r = await publish({ data: { version, fileUrl, acknowledgedWarning: understood } });
      toast.success(`Version ${r.version} is live. Existing participants keep the version they were measured under.`);
      setVersion("");
      setFileUrl("");
      setUnderstood(false);
      setConfirming(false);
      await qc.invalidateQueries({ queryKey: ["admin-standard"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">Participant Eligibility Standard</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        A versioned document. Exactly one version is live. A new version applies only to declarations made after it takes effect: results already determined stay tied to the version they were determined under.
      </p>

      {isLoading ? <p className="mt-6 text-sm text-muted-foreground">Loading…</p> : null}
      {error ? <p className="mt-6 text-sm text-muted-foreground">{(error as Error).message}</p> : null}

      {data ? (
        <>
          <section className="mt-6 rounded-xl border border-border bg-card p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Live now</p>
            <p className="mt-1 font-display text-2xl font-semibold text-foreground">Version {data.live.version}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {standardDocumentName(data.live.version)}
              {data.live.effectiveFrom ? ` · effective ${when(data.live.effectiveFrom)}` : ""}
              {data.live.source === "bundled" ? " · built into this release (run standard-versions.sql to manage versions here)" : ""}
            </p>
            {data.live.fileUrl ? <p className="mt-1 break-all text-xs text-muted-foreground">{data.live.fileUrl}</p> : null}
          </section>

          {data.versions.length > 0 ? (
            <section className="mt-6 overflow-hidden rounded-xl border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Version</th>
                    <th className="px-4 py-3 text-left font-medium">Effective from</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                    <th className="px-4 py-3 text-left font-medium">Document</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.versions.map((v) => (
                    <tr key={v.version}>
                      <td className="px-4 py-3 font-medium text-foreground">{v.version}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{when(v.effective_from)}</td>
                      <td className="px-4 py-3 text-xs">{v.is_live ? <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700 dark:text-emerald-400">Live</span> : <span className="text-muted-foreground">Earlier version</span>}</td>
                      <td className="break-all px-4 py-3 text-xs text-muted-foreground">{v.file_url}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          <section className="mt-6 max-w-2xl space-y-4 rounded-xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold text-foreground">Publish a new version</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-muted-foreground">
                Version (newer than {data.live.version})
                <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.2" className="mt-1 block h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground" />
              </label>
              <label className="text-xs text-muted-foreground">
                Document {version ? `(named ${standardDocumentName(version)})` : ""}
                <input value={fileUrl} onChange={(e) => setFileUrl(e.target.value)} placeholder={`standards/${standardDocumentName(version || "1.2")}.pdf`} className="mt-1 block h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground" />
              </label>
            </div>
            <div role="alert" className="rounded-lg border-2 border-amber-500/60 bg-amber-500/10 p-3 text-sm text-foreground">
              {PUBLISH_WARNING}
            </div>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input type="checkbox" className="mt-1" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />I have read this warning.
            </label>
            {!confirming ? (
              <button type="button" disabled={!understood || !version.trim() || !fileUrl.trim()} onClick={() => setConfirming(true)} className="h-9 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">
                Publish version {version || "…"}
              </button>
            ) : (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <p className="text-sm text-foreground">
                  Version {version} becomes live now, and version {data.live.version} stops being live. Nobody who has already declared is re-measured.
                </p>
                <div className="flex gap-3">
                  <button type="button" disabled={busy} onClick={() => void submit()} className="h-9 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">
                    {busy ? "Publishing…" : "Yes, publish"}
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="text-sm text-muted-foreground">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
