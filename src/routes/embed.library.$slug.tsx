import { createFileRoute } from "@tanstack/react-router";
import { LibraryPlayer, useLibraryView } from "@/components/LibraryBits";
import { getPublicVideo } from "@/lib/library.functions";

/** For other sites and the YouTube channel: the player and nothing else. __root hides the site's nav here. */
export const Route = createFileRoute("/embed/library/$slug")({
  loader: ({ params }) => getPublicVideo({ data: { slug: params.slug } }),
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.title ?? "divieight" }, { name: "robots", content: "noindex" }],
  }),
  component: EmbedPage,
});

function EmbedPage() {
  const video = Route.useLoaderData();
  if (!video) return <p className="p-4 text-center text-sm text-muted-foreground">This video isn't available.</p>;
  return <EmbedPlayer slug={video.slug} videoId={video.videoId} title={video.title} />;
}

function EmbedPlayer({ slug, videoId, title }: { slug: string; videoId: string; title: string }) {
  useLibraryView(slug);
  return (
    <div className="relative h-screen w-full bg-black">
      <LibraryPlayer videoId={videoId} title={title} />
    </div>
  );
}
