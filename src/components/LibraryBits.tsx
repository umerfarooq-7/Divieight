import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { readStoredTokens } from "@/lib/agent-qr";
import { youtubeEmbedUrl } from "@/lib/library";
import { recordLibraryView } from "@/lib/library.functions";

export function LibraryPlayer({ videoId, title }: { videoId: string; title: string }) {
  return (
    <iframe
      src={youtubeEmbedUrl(videoId)}
      title={title}
      className="absolute inset-0 h-full w-full"
      style={{ border: 0 }}
      allow="encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}

/** One view per page load. Carries the agent's link if this browser came through one. */
export function useLibraryView(slug: string) {
  const record = useServerFn(recordLibraryView);
  const logged = useRef<string | null>(null);
  useEffect(() => {
    if (logged.current === slug) return;
    logged.current = slug;
    void record({ data: { slug, tokens: readStoredTokens() } }).catch(() => undefined);
  }, [slug, record]);
}

/** The stored link isn't touched here: it stamps the buyer when they register and sign in. */
export function StartOnboardingCta() {
  return (
    <div className="rounded-xl border border-border bg-card p-5 text-center shadow-sm sm:flex sm:items-center sm:justify-between sm:gap-4 sm:text-left">
      <p className="text-sm font-medium text-foreground">Ready to take the next step?</p>
      <Link
        to="/buyer/register"
        className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:mt-0"
      >
        Start onboarding
      </Link>
    </div>
  );
}
