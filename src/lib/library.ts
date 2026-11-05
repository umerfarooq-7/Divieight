/** Buyer Learning Library: the compliance path, YouTube links, slugs and the embed code. */

export type LibraryStatus = "draft" | "compliance_review" | "approved" | "published";

export const LIBRARY_CAPACITY = 24;

export const LIBRARY_STATUS_LABELS: Record<LibraryStatus, string> = {
  draft: "Draft",
  compliance_review: "In compliance review",
  approved: "Approved",
  published: "Published",
};

/** Same path as library-video guard in library.sql. Publishing is only ever from approved. */
export const LIBRARY_NEXT: Record<LibraryStatus, LibraryStatus[]> = {
  draft: ["compliance_review"],
  compliance_review: ["approved", "draft"],
  approved: ["published", "draft"],
  published: ["approved"],
};

export const LIBRARY_MOVE_LABELS: Record<string, string> = {
  "draft>compliance_review": "Send to compliance review",
  "compliance_review>approved": "Approve (compliance)",
  "compliance_review>draft": "Send back to draft",
  "approved>published": "Publish",
  "approved>draft": "Send back to draft",
  "published>approved": "Unpublish",
};

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The video id from a YouTube link, or null for anything that isn't exactly that. */
export function youtubeId(link: string | null | undefined): string | null {
  const text = (link ?? "").trim();
  if (!text) return null;
  if (YOUTUBE_ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  let id: string | null | undefined = null;
  if (host === "youtu.be") id = parts[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (parts[0] === "watch") id = url.searchParams.get("v");
    else if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live" || parts[0] === "v") id = parts[1];
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

export const canonicalYoutubeUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
/** The privacy-enhanced player: no YouTube cookies until someone presses play. */
export const youtubeEmbedUrl = (id: string) => `https://www.youtube-nocookie.com/embed/${id}?rel=0`;
export const youtubeThumbnail = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export const isValidSlug = (slug: string) => slug.length <= 80 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);

const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What the admin copies. The title is someone's typing, so it's escaped. */
export function embedCode(origin: string, slug: string, title: string): string {
  return `<iframe src="${origin}/embed/library/${slug}" title="${escapeAttr(title)}" width="560" height="315" style="border:0" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe>`;
}

export interface PublicLibraryVideo {
  title: string;
  slug: string;
  description: string | null;
  videoId: string;
}

/** Case-blind search over what a visitor can see. */
export function searchVideos<T extends Pick<PublicLibraryVideo, "title" | "description">>(videos: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return videos;
  return videos.filter((v) => `${v.title} ${v.description ?? ""}`.toLowerCase().includes(q));
}
