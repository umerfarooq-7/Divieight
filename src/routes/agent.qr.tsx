import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import QRCode from "qrcode";
import { Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format-date";
import { createAgentQrToken, getAgentQrPage, revokeAgentQrToken } from "@/lib/agent-qr.functions";
import type { AgentQrToken } from "@/lib/agent-qr.server";

export const Route = createFileRoute("/agent/qr")({
  head: () => ({
    meta: [
      { title: "QR code & link — divieight Professional Portal" },
      { name: "description", content: "Your personal divieight link and QR code, with a visit counter." },
      { property: "og:title", content: "QR code & link — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgentQrPage,
});

const KEY = ["agent-qr"];
const FIELD = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
const BUTTON = "inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50";

const deepLink = (token: string) => `${window.location.origin}/a/${token}`;

function AgentQrPage() {
  const { user } = useAuth();
  const load = useServerFn(getAgentQrPage);
  const create = useServerFn(createAgentQrToken);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: [...KEY, user?.id], enabled: !!user, retry: false, queryFn: () => load() });
  const [label, setLabel] = useState("");
  const createMut = useMutation({
    mutationFn: () => create({ data: { label } }),
    onSuccess: () => {
      toast.success("Link created.");
      setLabel("");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    createMut.mutate();
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="font-display text-2xl font-semibold text-foreground">QR code &amp; link</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Share your link or QR code. A buyer who opens it and then registers is noted as having come through you. Choosing an agent stays with the buyer: this doesn't connect them to you.
      </p>
      <div className="mt-6 space-y-4">
        {isLoading || !user ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : !data?.isAgent ? (
          <p className="text-sm text-muted-foreground">This page is for agents.</p>
        ) : (
          <>
            {data.tokens.map((t) => (
              <TokenCard key={t.id} row={t} />
            ))}
            <form onSubmit={submit} className="rounded-xl border border-border bg-card p-5 shadow-sm">
              <label htmlFor="qr-label" className="text-sm font-medium text-foreground">
                Add another link, for example for a flyer or an event
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                <input id="qr-label" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" className={`${FIELD} min-w-0 flex-1`} />
                <button type="submit" disabled={createMut.isPending || !label.trim()} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                  Create link
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function download(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
}

function TokenCard({ row }: { row: AgentQrToken }) {
  const qc = useQueryClient();
  const revoke = useServerFn(revokeAgentQrToken);
  const [png, setPng] = useState("");
  const live = !row.revokedAt;
  const link = deepLink(row.token);
  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(link, { width: 640, margin: 2 }).then((url) => {
      if (!cancelled) setPng(url);
    });
    return () => {
      cancelled = true;
    };
  }, [link]);
  const revokeMut = useMutation({
    mutationFn: () => revoke({ data: { tokenId: row.id } }),
    onSuccess: () => {
      toast.success("Link revoked. Buyers already noted stay noted.");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const downloadSvg = async () => {
    const svg = await QRCode.toString(link, { type: "svg", margin: 2 });
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    download(url, `divieight-qr-${row.token}.svg`);
    URL.revokeObjectURL(url);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link copied.");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it by hand.");
    }
  };

  return (
    <section className={`rounded-xl border border-border bg-card p-5 shadow-sm ${live ? "" : "opacity-60"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 break-words font-display text-base font-semibold text-foreground">{row.label || (row.isDefault ? "Your link" : "Link")}</h2>
        <p className="text-sm text-muted-foreground">
          {row.visits} {row.visits === 1 ? "visit" : "visits"}
          {live ? "" : ` · Revoked ${formatDate(row.revokedAt)}`}
        </p>
      </div>
      <p className="mt-2 break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">{link}</p>
      {live ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            {png ? <img src={png} alt={`QR code for ${link}`} className="h-36 w-36 rounded-lg border border-border" /> : <div className="h-36 w-36 rounded-lg bg-muted" />}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void copy()} className={BUTTON}>
                <Copy className="h-4 w-4" aria-hidden /> Copy link
              </button>
              <button type="button" disabled={!png} onClick={() => download(png, `divieight-qr-${row.token}.png`)} className={BUTTON}>
                <Download className="h-4 w-4" aria-hidden /> PNG
              </button>
              <button type="button" onClick={() => void downloadSvg()} className={BUTTON}>
                <Download className="h-4 w-4" aria-hidden /> SVG
              </button>
              <button type="button" disabled={revokeMut.isPending} onClick={() => revokeMut.mutate()} className={BUTTON}>
                Revoke
              </button>
            </div>
          </div>
          {row.isDefault ? <p className="mt-2 text-xs text-muted-foreground">If you revoke this one, a new default link is made next time you open this page.</p> : null}
        </>
      ) : null}
    </section>
  );
}
