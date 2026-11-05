import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { LibraryPlayer, StartOnboardingCta, useLibraryView } from "@/components/LibraryBits";
import { getPublicVideo } from "@/lib/library.functions";

export const Route = createFileRoute("/library/$slug")({
  loader: async ({ params }) => {
    const video = await getPublicVideo({ data: { slug: params.slug } });
    if (!video) throw notFound();
    return video;
  },
  head: ({ loaderData }) => {
    const title = loaderData ? `${loaderData.title} — divieight` : "Video — divieight";
    const description = loaderData?.description || "A video from the divieight Buyer Learning Library.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "video.other" },
        { name: "twitter:card", content: "summary" },
      ],
    };
  },
  notFoundComponent: () => (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="font-display text-2xl font-semibold text-foreground">This video isn't available</h1>
      <Link to="/library" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
        Back to the library
      </Link>
    </div>
  ),
  component: VideoPage,
});

function VideoPage() {
  const video = Route.useLoaderData();
  useLibraryView(video.slug);
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      <Link to="/library" className="text-sm text-muted-foreground hover:text-foreground">
        ← Library
      </Link>
      <h1 className="mt-3 break-words font-display text-2xl font-semibold text-foreground sm:text-3xl">{video.title}</h1>
      <div className="relative mt-4 aspect-video overflow-hidden rounded-xl bg-muted">
        <LibraryPlayer videoId={video.videoId} title={video.title} />
      </div>
      {video.description ? <p className="mt-4 whitespace-pre-wrap break-words text-sm text-foreground sm:text-base">{video.description}</p> : null}
      <div className="mt-8">
        <StartOnboardingCta />
      </div>
    </div>
  );
}
