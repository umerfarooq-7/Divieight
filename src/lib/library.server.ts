/**
 * Buyer Learning Library (server side). The public gets published videos and nothing
 * else, without their scripts. library.sql holds the same compliance path, so a write
 * from anywhere else can't skip it. Every admin step goes to the audit log.
 */

import { isAttributionToken } from "@/lib/agent-qr";
import {
  canonicalYoutubeUrl,
  isValidSlug,
  LIBRARY_CAPACITY,
  LIBRARY_NEXT,
  LIBRARY_STATUS_LABELS,
  youtubeId,
  type LibraryStatus,
  type PublicLibraryVideo,
} from "@/lib/library";

type Db = { from: (t: string) => any };

const MISSING_SCHEMA = "Database is missing the library — run library.sql in Supabase.";

interface VideoRow {
  id: string;
  cluster_id: string;
  title: string;
  slug: string;
  description: string | null;
  youtube_url: string | null;
  script_text: string | null;
  status: LibraryStatus;
  compliance_approved_by: string | null;
  compliance_approved_at: string | null;
  sort_order: number;
}

const publicVideo = (r: VideoRow): PublicLibraryVideo | null => {
  const videoId = youtubeId(r.youtube_url);
  return videoId ? { title: r.title, slug: r.slug, description: r.description, videoId } : null;
};

const bySortOrder = <T extends { sort_order: number }>(rows: T[]) => [...rows].sort((a, b) => a.sort_order - b.sort_order);

export async function publicLibrary(db: Db): Promise<{ clusters: Array<{ id: string; name: string; videos: PublicLibraryVideo[] }> }> {
  const { data: clusters, error } = await db.from("library_clusters").select("id, name, sort_order").order("sort_order", { ascending: true });
  if (error) return { clusters: [] }; // before library.sql is run
  const { data: videos } = await db.from("library_videos").select("*").eq("status", "published");
  const rows = bySortOrder((videos ?? []) as VideoRow[]);
  return {
    clusters: ((clusters ?? []) as Array<{ id: string; name: string }>).map((c) => ({
      id: c.id,
      name: c.name,
      videos: rows
        .filter((r) => r.cluster_id === c.id)
        .map(publicVideo)
        .filter((v): v is PublicLibraryVideo => v !== null),
    })),
  };
}

export async function publicVideoBySlug(db: Db, slug: string): Promise<PublicLibraryVideo | null> {
  if (!isValidSlug(slug)) return null;
  const { data, error } = await db.from("library_videos").select("*").eq("slug", slug).eq("status", "published").maybeSingle();
  if (error || !data) return null;
  return publicVideo(data as VideoRow);
}

/**
 * A view of a published video. Tokens come oldest first, as the browser holds them:
 * the first one still live is logged. A view never fails for the visitor.
 */
export async function recordView(db: Db, params: { slug: string; tokens: string[] }): Promise<{ logged: boolean }> {
  if (!isValidSlug(params.slug)) return { logged: false };
  const { data: video, error } = await db.from("library_videos").select("id").eq("slug", params.slug).eq("status", "published").maybeSingle();
  if (error || !video) return { logged: false };
  let tokenId: string | null = null;
  for (const token of params.tokens.filter(isAttributionToken)) {
    const { data } = await db.from("agent_attribution_tokens").select("id, revoked_at").eq("token", token).maybeSingle();
    if (data && !data.revoked_at) {
      tokenId = data.id as string;
      break;
    }
  }
  const { error: insertError } = await db.from("library_view_events").insert({ video_id: video.id, attribution_token_id: tokenId });
  return { logged: !insertError };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

async function audit(db: Db, adminId: string, action: string, id: string, extra: Record<string, unknown> = {}) {
  await db.from("audit_log").insert({
    actor_id: adminId,
    actor_type: "admin",
    action_type: action,
    entity_type: "library_video",
    entity_id: id,
    metadata: { at: new Date().toISOString(), ...extra },
  });
}

export interface AdminLibraryVideo {
  id: string;
  clusterId: string;
  title: string;
  slug: string;
  description: string | null;
  youtubeUrl: string | null;
  scriptText: string | null;
  status: LibraryStatus;
  approvedAt: string | null;
  sortOrder: number;
  views: number;
  nextStatuses: LibraryStatus[];
}

export async function adminLibrary(db: Db) {
  const { data: clusters, error } = await db.from("library_clusters").select("id, name, sort_order").order("sort_order", { ascending: true });
  if (error) throw new Error(MISSING_SCHEMA);
  const { data: videos } = await db.from("library_videos").select("*");
  const rows = bySortOrder((videos ?? []) as VideoRow[]);
  const out: AdminLibraryVideo[] = [];
  for (const r of rows) {
    const { count } = await db.from("library_view_events").select("id", { count: "exact", head: true }).eq("video_id", r.id);
    out.push({
      id: r.id,
      clusterId: r.cluster_id,
      title: r.title,
      slug: r.slug,
      description: r.description,
      youtubeUrl: r.youtube_url,
      scriptText: r.script_text,
      status: r.status,
      approvedAt: r.compliance_approved_at,
      sortOrder: r.sort_order,
      views: count ?? 0,
      nextStatuses: LIBRARY_NEXT[r.status],
    });
  }
  return { clusters: (clusters ?? []) as Array<{ id: string; name: string }>, videos: out, capacity: LIBRARY_CAPACITY };
}

export interface VideoInput {
  clusterId: string;
  title: string;
  slug: string;
  description: string | null;
  youtubeUrl: string | null;
  scriptText: string | null;
  sortOrder: number;
}

function contentRow(input: VideoInput) {
  if (!isValidSlug(input.slug)) throw new Error("A slug uses lowercase letters, numbers and single hyphens.");
  let youtube_url: string | null = null;
  if (input.youtubeUrl) {
    const id = youtubeId(input.youtubeUrl);
    if (!id) throw new Error("That isn't a YouTube video link.");
    youtube_url = canonicalYoutubeUrl(id);
  }
  return {
    cluster_id: input.clusterId,
    title: input.title,
    slug: input.slug,
    description: input.description,
    youtube_url,
    script_text: input.scriptText,
    sort_order: input.sortOrder,
  };
}

const friendly = (error: { code?: string; message: string }) => {
  if (error.code === "23505") return "That slug is already used by another video.";
  if (/does not exist|schema cache/i.test(error.message)) return MISSING_SCHEMA;
  return error.message;
};

async function requireCluster(db: Db, clusterId: string) {
  const { data } = await db.from("library_clusters").select("id").eq("id", clusterId).maybeSingle();
  if (!data) throw new Error("Choose a cluster.");
}

export async function createVideo(db: Db, params: { adminId: string; input: VideoInput }): Promise<{ id: string }> {
  const row = contentRow(params.input);
  await requireCluster(db, params.input.clusterId);
  const { count, error: countError } = await db.from("library_videos").select("id", { count: "exact", head: true });
  if (countError) throw new Error(MISSING_SCHEMA);
  if ((count ?? 0) >= LIBRARY_CAPACITY) throw new Error(`The library holds ${LIBRARY_CAPACITY} videos.`);
  const { data, error } = await db.from("library_videos").insert({ ...row, status: "draft" }).select("*").maybeSingle();
  if (error || !data) throw new Error(error ? friendly(error) : MISSING_SCHEMA);
  await audit(db, params.adminId, "library.video_created", data.id as string, { slug: row.slug });
  return { id: data.id as string };
}

async function loadVideo(db: Db, id: string): Promise<VideoRow> {
  const { data } = await db.from("library_videos").select("*").eq("id", id).maybeSingle();
  if (!data) throw new Error("Video not found");
  return data as VideoRow;
}

/** Approval was for what a viewer saw then, so changing that returns the video to draft. */
export async function updateVideo(db: Db, params: { adminId: string; videoId: string; input: VideoInput }): Promise<{ returnedToDraft: boolean }> {
  const video = await loadVideo(db, params.videoId);
  const row = contentRow(params.input);
  await requireCluster(db, params.input.clusterId);
  const contentChanged =
    row.title !== video.title ||
    row.slug !== video.slug ||
    (row.description ?? null) !== (video.description ?? null) ||
    (row.youtube_url ?? null) !== (video.youtube_url ?? null) ||
    (row.script_text ?? null) !== (video.script_text ?? null);
  const returnedToDraft = contentChanged && video.status !== "draft";
  const { data, error } = await db
    .from("library_videos")
    .update({ ...row, ...(returnedToDraft ? { status: "draft", compliance_approved_by: null, compliance_approved_at: null } : {}) })
    .eq("id", video.id)
    .eq("status", video.status)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(friendly(error));
  if (!data) throw new Error("This video just changed. Reload and try again.");
  await audit(db, params.adminId, returnedToDraft ? "library.video_returned_to_draft" : "library.video_updated", video.id, { from_status: video.status, content_changed: contentChanged });
  return { returnedToDraft };
}

export async function moveVideo(db: Db, params: { adminId: string; videoId: string; status: LibraryStatus }) {
  const video = await loadVideo(db, params.videoId);
  if (!LIBRARY_NEXT[video.status].includes(params.status))
    throw new Error(`A video that is ${LIBRARY_STATUS_LABELS[video.status].toLowerCase()} can't move to ${LIBRARY_STATUS_LABELS[params.status].toLowerCase()}.`);
  if (params.status === "compliance_review" && (!youtubeId(video.youtube_url) || !video.script_text?.trim()))
    throw new Error("A video needs its YouTube link and script before review.");

  const patch: Record<string, unknown> = { status: params.status };
  if (video.status === "compliance_review" && params.status === "approved") {
    patch["compliance_approved_by"] = params.adminId;
    patch["compliance_approved_at"] = new Date().toISOString();
  }
  if (params.status === "draft") {
    patch["compliance_approved_by"] = null;
    patch["compliance_approved_at"] = null;
  }
  const { data, error } = await db.from("library_videos").update(patch).eq("id", video.id).eq("status", video.status).select("id").maybeSingle();
  if (error) throw new Error(friendly(error));
  if (!data) throw new Error("This video just changed. Reload and try again.");
  await audit(db, params.adminId, `library.video_${params.status}`, video.id, { from_status: video.status, to_status: params.status });
}

/** Only a draft nobody has watched, so view history never disappears. */
export async function deleteDraft(db: Db, params: { adminId: string; videoId: string }) {
  const video = await loadVideo(db, params.videoId);
  if (video.status !== "draft") throw new Error("Only a draft can be deleted.");
  const { count } = await db.from("library_view_events").select("id", { count: "exact", head: true }).eq("video_id", video.id);
  if (count) throw new Error("This video has view history, so it can't be deleted.");
  const { error } = await db.from("library_videos").delete().eq("id", video.id).eq("status", "draft");
  if (error) throw new Error(friendly(error));
  await audit(db, params.adminId, "library.video_deleted", video.id, { slug: video.slug });
}

export async function renameCluster(db: Db, params: { adminId: string; clusterId: string; name: string }) {
  const { data } = await db.from("library_clusters").update({ name: params.name }).eq("id", params.clusterId).select("id").maybeSingle();
  if (!data) throw new Error("Cluster not found");
  await db.from("audit_log").insert({
    actor_id: params.adminId,
    actor_type: "admin",
    action_type: "library.cluster_renamed",
    entity_type: "library_cluster",
    entity_id: params.clusterId,
    metadata: { name: params.name },
  });
}
