import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PlayCircle, Search } from "lucide-react";
import { StartOnboardingCta } from "@/components/LibraryBits";
import { searchVideos, youtubeThumbnail, type PublicLibraryVideo } from "@/lib/library";
import { getPublicLibrary } from "@/lib/library.functions";

export const Route = createFileRoute("/library/")({
  loader: () => getPublicLibrary(),
  head: () => ({
    meta: [
      { title: "Buyer Learning Library — divieight" },
      { name: "description", content: "Short videos for people learning about divieight." },
      { property: "og:title", content: "Buyer Learning Library — divieight" },
      { property: "og:description", content: "Short videos for people learning about divieight." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LibraryPage,
});

function LibraryPage() {
  const { clusters } = Route.useLoaderData();
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const shown = useMemo(() => clusters.map((c) => ({ ...c, videos: searchVideos(c.videos, query) })), [clusters, query]);
  const matches = shown.reduce((sum, c) => sum + c.videos.length, 0);
  const total = clusters.reduce((sum, c) => sum + c.videos.length, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <h1 className="font-display text-3xl font-semibold text-foreground sm:text-4xl">Buyer Learning Library</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">Short videos, grouped by topic.</p>

      {total > 0 ? (
        <div className="relative mt-6 max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            aria-label="Search videos"
            placeholder="Search videos"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-h-11 w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm"
          />
        </div>
      ) : null}

      <div className="mt-8 space-y-10">
        {clusters.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Coming soon</p>
        ) : searching && matches === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No videos match your search.</p>
        ) : (
          shown
            .filter((c) => !searching || c.videos.length > 0)
            .map((c) => (
              <section key={c.id} aria-labelledby={`cluster-${c.id}`}>
                <h2 id={`cluster-${c.id}`} className="font-display text-xl font-semibold text-foreground">
                  {c.name}
                </h2>
                {c.videos.length === 0 ? (
                  <p className="mt-3 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Coming soon</p>
                ) : (
                  <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {c.videos.map((v) => (
                      <VideoCard key={v.slug} video={v} />
                    ))}
                  </div>
                )}
              </section>
            ))
        )}
      </div>

      <div className="mt-10">
        <StartOnboardingCta />
      </div>
    </div>
  );
}

function VideoCard({ video: v }: { video: PublicLibraryVideo }) {
  return (
    <Link to="/library/$slug" params={{ slug: v.slug }} className="group block overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-colors hover:border-accent">
      <div className="relative aspect-video bg-muted">
        <img src={youtubeThumbnail(v.videoId)} alt="" loading="lazy" className="h-full w-full object-cover" />
        <PlayCircle className="absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2 text-white drop-shadow" aria-hidden />
      </div>
      <div className="p-4">
        <h3 className="break-words font-medium text-foreground group-hover:underline">{v.title}</h3>
        {v.description ? <p className="mt-1 line-clamp-2 break-words text-sm text-muted-foreground">{v.description}</p> : null}
      </div>
    </Link>
  );
}
