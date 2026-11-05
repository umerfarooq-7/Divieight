import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/format-date";
import { embedCode, LIBRARY_MOVE_LABELS, LIBRARY_STATUS_LABELS, slugify, type LibraryStatus } from "@/lib/library";
import {
  createLibraryVideo,
  deleteLibraryDraft,
  listLibraryForAdmin,
  moveLibraryVideo,
  renameLibraryCluster,
  updateLibraryVideo,
} from "@/lib/library.functions";
import type { AdminLibraryVideo } from "@/lib/library.server";

export const Route = createFileRoute("/admin/library")({
  head: () => ({
    meta: [
      { title: "Library — divieight admin" },
      { name: "description", content: "Manage the Buyer Learning Library and its compliance review." },
      { property: "og:title", content: "Library — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminLibraryPage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";
const PRIMARY = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";
const SECONDARY = "rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50";
const KEY = ["admin-library"];

type Cluster = { id: string; name: string };

function AdminLibraryPage() {
  const load = useServerFn(listLibraryForAdmin);
  const { data, isLoading, error } = useQuery({ queryKey: KEY, queryFn: () => load(), retry: false });
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold text-foreground">Library</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        A video goes from draft to compliance review, is approved by an admin, and only then can be published. The public sees published videos only. Changing a video's content returns it to draft.
      </p>
      <div className="mt-6 space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : !data ? null : (
          <>
            <Clusters clusters={data.clusters} />
            <p className="text-sm font-medium text-foreground">
              {data.videos.length} of {data.capacity} videos
            </p>
            {data.videos.length < data.capacity ? <VideoForm clusters={data.clusters} /> : null}
            {data.videos.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">No videos yet.</p>
            ) : (
              data.videos.map((v) => <VideoCard key={v.id} video={v} clusters={data.clusters} />)
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Clusters({ clusters }: { clusters: Cluster[] }) {
  return (
    <details className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <summary className="cursor-pointer font-display text-lg font-semibold text-foreground">Clusters</summary>
      <p className="mt-1 text-sm text-muted-foreground">These names are placeholders. Renaming one changes it on the public page right away.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {clusters.map((c) => (
          <ClusterRow key={c.id} cluster={c} />
        ))}
      </div>
    </details>
  );
}

function ClusterRow({ cluster }: { cluster: Cluster }) {
  const qc = useQueryClient();
  const rename = useServerFn(renameLibraryCluster);
  const [name, setName] = useState(cluster.name);
  const mut = useMutation({
    mutationFn: () => rename({ data: { clusterId: cluster.id, name } }),
    onSuccess: () => {
      toast.success("Renamed.");
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="flex gap-2">
      <input aria-label={`Name of ${cluster.name}`} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
      <button type="button" disabled={mut.isPending || !name.trim() || name === cluster.name} onClick={() => mut.mutate()} className={SECONDARY}>
        Save
      </button>
    </div>
  );
}

function VideoForm({ clusters, video, onDone }: { clusters: Cluster[]; video?: AdminLibraryVideo; onDone?: () => void }) {
  const qc = useQueryClient();
  const create = useServerFn(createLibraryVideo);
  const update = useServerFn(updateLibraryVideo);
  const [clusterId, setClusterId] = useState(video?.clusterId ?? clusters[0]?.id ?? "");
  const [title, setTitle] = useState(video?.title ?? "");
  const [slug, setSlug] = useState(video?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(video));
  const [description, setDescription] = useState(video?.description ?? "");
  const [youtubeUrl, setYoutubeUrl] = useState(video?.youtubeUrl ?? "");
  const [scriptText, setScriptText] = useState(video?.scriptText ?? "");
  const [sortOrder, setSortOrder] = useState(String(video?.sortOrder ?? 0));
  const input = { clusterId, title, slug, description, youtubeUrl, scriptText, sortOrder: Number(sortOrder) };
  const mut = useMutation({
    mutationFn: async () => {
      if (video) return update({ data: { videoId: video.id, input } });
      await create({ data: input });
      return { returnedToDraft: false };
    },
    onSuccess: (r) => {
      toast.success(r.returnedToDraft ? "Saved. The content changed, so it's back to draft for review." : "Saved.");
      if (!video) {
        setTitle("");
        setSlug("");
        setSlugTouched(false);
        setDescription("");
        setYoutubeUrl("");
        setScriptText("");
      }
      onDone?.();
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mut.mutate();
  };
  const fields = (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-foreground">
          Title
          <input
            required
            maxLength={200}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
            className={FIELD}
          />
        </label>
        <label className="block text-sm font-medium text-foreground">
          Slug
          <input
            required
            maxLength={80}
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            className={FIELD}
          />
        </label>
        <label className="block text-sm font-medium text-foreground">
          Cluster
          <select value={clusterId} onChange={(e) => setClusterId(e.target.value)} className={FIELD}>
            {clusters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-foreground">
          Order within the cluster
          <input type="number" step="1" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className={FIELD} />
        </label>
      </div>
      <label className="block text-sm font-medium text-foreground">
        YouTube link
        <input type="url" maxLength={500} value={youtubeUrl} onChange={(e) => setYoutubeUrl(e.target.value)} className={FIELD} />
      </label>
      <label className="block text-sm font-medium text-foreground">
        Description: the public sees this
        <textarea rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} className={FIELD} />
      </label>
      <label className="block text-sm font-medium text-foreground">
        Script: for compliance review, not shown publicly
        <textarea rows={4} maxLength={50000} value={scriptText} onChange={(e) => setScriptText(e.target.value)} className={FIELD} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={mut.isPending || !title.trim() || !slug.trim() || !clusterId} className={PRIMARY}>
          {mut.isPending ? "Saving…" : video ? "Save changes" : "Save draft"}
        </button>
        {onDone ? (
          <button type="button" onClick={onDone} className={SECONDARY}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
  if (video) return fields;
  return (
    <details className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <summary className="cursor-pointer font-display text-lg font-semibold text-foreground">New video</summary>
      <div className="mt-3">{fields}</div>
    </details>
  );
}

function VideoCard({ video: v, clusters }: { video: AdminLibraryVideo; clusters: Cluster[] }) {
  const qc = useQueryClient();
  const move = useServerFn(moveLibraryVideo);
  const remove = useServerFn(deleteLibraryDraft);
  const [editing, setEditing] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const moveMut = useMutation({
    mutationFn: (status: LibraryStatus) => move({ data: { videoId: v.id, status } }),
    onSuccess: () => {
      toast.success("Updated.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeMut = useMutation({
    mutationFn: () => remove({ data: { videoId: v.id } }),
    onSuccess: () => {
      toast.success("Deleted.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 break-words font-display text-base font-semibold text-foreground">{v.title}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">{LIBRARY_STATUS_LABELS[v.status]}</span>
      </div>
      <p className="mt-1 break-words text-xs text-muted-foreground">
        {clusters.find((c) => c.id === v.clusterId)?.name ?? "Cluster"} · /library/{v.slug} · {v.views} {v.views === 1 ? "view" : "views"}
        {v.approvedAt ? ` · Compliance approved ${formatDate(v.approvedAt)}` : ""}
      </p>
      {editing ? (
        <div className="mt-4 border-t border-border pt-4">
          <VideoForm clusters={clusters} video={v} onDone={() => setEditing(false)} />
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {v.nextStatuses.map((s) => (
            <button key={s} type="button" disabled={moveMut.isPending} onClick={() => moveMut.mutate(s)} className={s === "draft" || s === "approved" && v.status === "published" ? SECONDARY : PRIMARY}>
              {LIBRARY_MOVE_LABELS[`${v.status}>${s}`]}
            </button>
          ))}
          <button type="button" onClick={() => setEditing(true)} className={SECONDARY}>
            Edit
          </button>
          {v.status === "draft" && v.views === 0 ? (
            <button type="button" disabled={removeMut.isPending} onClick={() => removeMut.mutate()} className={SECONDARY}>
              Delete
            </button>
          ) : null}
          {v.status === "published" ? (
            <Link to="/library/$slug" params={{ slug: v.slug }} className={SECONDARY}>
              View
            </Link>
          ) : null}
        </div>
      )}
      {v.status === "published" ? <EmbedBox slug={v.slug} title={v.title} /> : null}
    </section>
  );
}

function EmbedBox({ slug, title }: { slug: string; title: string }) {
  const code = embedCode(window.location.origin, slug, title);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Embed code copied.");
    } catch {
      toast.error("Couldn't copy. Select the code and copy it by hand.");
    }
  };
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">Embed code</p>
        <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">
          <Copy className="h-4 w-4" aria-hidden /> Copy
        </button>
      </div>
      <textarea readOnly aria-label="Embed code" rows={3} value={code} className="mt-2 w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground" />
    </div>
  );
}
