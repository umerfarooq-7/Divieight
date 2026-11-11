/** Buyer Learning Library: what the public can see, the compliance path, YouTube links, views and attribution. */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { harness } from "./setup";
import { seedPod, IDS, USERS } from "./fixtures";
import { embedCode, isValidSlug, searchVideos, slugify, youtubeId, youtubeEmbedUrl } from "@/lib/library";
import {
  createLibraryVideo,
  deleteLibraryDraft,
  getPublicLibrary,
  getPublicVideo,
  listLibraryForAdmin,
  moveLibraryVideo,
  recordLibraryView,
  renameLibraryCluster,
  updateLibraryVideo,
} from "@/lib/library.functions";
import { recordView } from "@/lib/library.server";

const as = (user: string) => (harness.userId = user);
const db = () => harness.db;
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const C1 = "cluster-1", C2 = "cluster-2";
const TOKEN = "aaaaaaaaaaaa", TOKEN2 = "bbbbbbbbbbbb";

function seed() {
  seedPod(db());
  db().rpcResults.has_role = (a: { _user_id: string; _role: string }) => a._role === "admin" && [USERS.admin, "u-admin-approver"].includes(a._user_id);
  db().seed("library_clusters", [
    { id: C1, name: "Basics", sort_order: 1 },
    { id: C2, name: "Co-Ownership", sort_order: 2 },
  ]);
  db().seed("agent_attribution_tokens", [
    { id: "tok-1", agent_id: IDS.ra, token: TOKEN, revoked_at: null },
    { id: "tok-2", agent_id: IDS.ra2, token: TOKEN2, revoked_at: null },
  ]);
}

const input = (o: Record<string, unknown> = {}) => ({ clusterId: C1, title: "First video", slug: "first-video", description: "About it", youtubeUrl: YT, scriptText: "The script", sortOrder: 0, ...o });
const create = async (o: Record<string, unknown> = {}) => {
  as(USERS.admin);
  return (await createLibraryVideo({ data: input(o) as never })).id;
};
/** Compliance approval is by a different admin than the creator. */
const APPROVER = "u-admin-approver";
const move = (videoId: string, status: string) => {
  as(status === "approved" ? APPROVER : USERS.admin);
  return moveLibraryVideo({ data: { videoId, status } as never });
};
const publish = async (id: string) => {
  await move(id, "compliance_review");
  await move(id, "approved");
  await move(id, "published");
};
const row = (id: string) => db().table("library_videos").find((v) => v.id === id)!;
const publicSlugs = async () => {
  as("");
  return (await getPublicLibrary()).clusters.flatMap((c) => c.videos.map((v) => v.slug));
};

describe("what the public sees", () => {
  it("a draft, a video in review and an approved one are invisible, in the list and by address", async () => {
    seed();
    const id = await create();
    for (const status of [null, "compliance_review", "approved"]) {
      if (status) await move(id, status);
      expect(await publicSlugs()).toEqual([]);
      expect(await getPublicVideo({ data: { slug: "first-video" } })).toBeNull();
      expect(await recordLibraryView({ data: { slug: "first-video" } })).toEqual({ logged: false });
    }
    expect(db().table("library_view_events")).toEqual([]);
  });

  it("publishing shows it; unpublishing hides it", async () => {
    seed();
    const id = await create();
    await publish(id);
    expect(await publicSlugs()).toEqual(["first-video"]);
    expect(await getPublicVideo({ data: { slug: "first-video" } })).toEqual({ title: "First video", slug: "first-video", description: "About it", videoId: "dQw4w9WgXcQ" });
    await move(id, "approved");
    expect(await publicSlugs()).toEqual([]);
  });

  it("the script and the review details never reach the public", async () => {
    seed();
    await publish(await create());
    as("");
    const text = JSON.stringify([await getPublicLibrary(), await getPublicVideo({ data: { slug: "first-video" } })]);
    expect(text).not.toContain("The script");
    expect(text).not.toContain(USERS.admin);
    expect(text).not.toContain("compliance");
  });

  it("every cluster shows, in order, even with no videos; videos go under their own", async () => {
    seed();
    await publish(await create({ clusterId: C2 }));
    as("");
    const { clusters } = await getPublicLibrary();
    expect(clusters.map((c) => [c.name, c.videos.length])).toEqual([["Basics", 0], ["Co-Ownership", 1]]);
  });

  it("orders videos within a cluster", async () => {
    seed();
    const b = await create({ title: "B", slug: "b", sortOrder: 2 });
    const a = await create({ title: "A", slug: "a", sortOrder: 1 });
    await publish(b);
    await publish(a);
    expect(await publicSlugs()).toEqual(["a", "b"]);
  });

  it("before the SQL is run the public page is just empty", async () => {
    const failing = { from: () => ({ select: () => ({ order: async () => ({ data: null, error: { message: "missing" } }) }) }) };
    const { publicLibrary } = await import("@/lib/library.server");
    expect(await publicLibrary(failing as never)).toEqual({ clusters: [] });
  });
});

describe("the compliance path", () => {
  it("can't skip a step, by any route", async () => {
    seed();
    const id = await create();
    await expect(move(id, "published")).rejects.toThrow("can't move");
    await expect(move(id, "approved")).rejects.toThrow("can't move");
    await move(id, "compliance_review");
    await expect(move(id, "published")).rejects.toThrow("can't move");
    await move(id, "approved");
    await move(id, "published");
    expect(row(id).status).toBe("published");
    await expect(move(id, "compliance_review")).rejects.toThrow("can't move");
  });

  it("approval records the admin; going back to draft clears it", async () => {
    seed();
    const id = await create();
    await move(id, "compliance_review");
    expect(row(id).compliance_approved_by ?? null).toBeNull();
    await move(id, "approved");
    expect(row(id).compliance_approved_by).toBe(APPROVER);
    expect(row(id).compliance_approved_at).toBeTruthy();
    await move(id, "draft");
    expect(row(id).compliance_approved_by).toBeNull();
    expect(row(id).compliance_approved_at).toBeNull();
  });

  it("unpublishing keeps the approval, so it can go straight back up", async () => {
    seed();
    const id = await create();
    await publish(id);
    await move(id, "approved");
    expect(row(id).compliance_approved_by).toBe(APPROVER);
    await move(id, "published");
    expect(row(id).status).toBe("published");
  });

  it("needs its YouTube link and script before review", async () => {
    seed();
    const noLink = await create({ slug: "a", youtubeUrl: "" });
    const noScript = await create({ slug: "b", scriptText: "  " });
    await expect(move(noLink, "compliance_review")).rejects.toThrow("before review");
    await expect(move(noScript, "compliance_review")).rejects.toThrow("before review");
  });

  it("changing what viewers see takes it down, back to draft, approval gone", async () => {
    seed();
    for (const change of [{ title: "New" }, { slug: "new-slug" }, { description: "New" }, { youtubeUrl: "https://youtu.be/aaaaaaaaaaa" }, { scriptText: "New" }]) {
      const id = await create({ slug: `v-${Object.keys(change)[0]!.toLowerCase()}` });
      await publish(id);
      as(USERS.admin);
      const result = await updateLibraryVideo({ data: { videoId: id, input: input({ slug: row(id).slug, ...change }) as never } });
      expect(result).toEqual({ returnedToDraft: true });
      expect(row(id)).toMatchObject({ status: "draft", compliance_approved_by: null, compliance_approved_at: null });
    }
    expect(await publicSlugs()).toEqual([]);
  });

  it("moving a video's cluster or order doesn't need a new review", async () => {
    seed();
    const id = await create();
    await publish(id);
    as(USERS.admin);
    expect(await updateLibraryVideo({ data: { videoId: id, input: input({ clusterId: C2, sortOrder: 5 }) as never } })).toEqual({ returnedToDraft: false });
    expect(row(id)).toMatchObject({ status: "published", cluster_id: C2, sort_order: 5 });
  });

  it("two admins on the same video: the second sees it changed", async () => {
    seed();
    const id = await create();
    const { moveVideo } = await import("@/lib/library.server");
    const results = await Promise.allSettled([moveVideo(db() as never, { adminId: USERS.admin, videoId: id, status: "compliance_review" }), moveVideo(db() as never, { adminId: USERS.admin, videoId: id, status: "compliance_review" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(db().audits("library.video_compliance_review")).toHaveLength(1);
  });

  it("only an admin does any of it", async () => {
    seed();
    const id = await create();
    for (const user of [USERS.b1, USERS.ra, ""]) {
      as(user);
      await expect(listLibraryForAdmin()).rejects.toThrow("Not authorized");
      await expect(createLibraryVideo({ data: input({ slug: "x" }) as never })).rejects.toThrow("Not authorized");
      await expect(moveLibraryVideo({ data: { videoId: id, status: "compliance_review" } })).rejects.toThrow("Not authorized");
      await expect(updateLibraryVideo({ data: { videoId: id, input: input() as never } })).rejects.toThrow("Not authorized");
      await expect(deleteLibraryDraft({ data: { videoId: id } })).rejects.toThrow("Not authorized");
      await expect(renameLibraryCluster({ data: { clusterId: C1, name: "x" } })).rejects.toThrow("Not authorized");
    }
    expect(row(id).status).toBe("draft");
  });

  it("each step reaches the audit log", async () => {
    seed();
    await publish(await create());
    for (const action of ["library.video_created", "library.video_compliance_review", "library.video_approved", "library.video_published"]) expect(db().audits(action)).toHaveLength(1);
  });
});

describe("capacity and upkeep", () => {
  it("holds 24 videos", async () => {
    seed();
    for (let i = 0; i < 24; i += 1) await create({ slug: `v${i}` });
    await expect(create({ slug: "v24" })).rejects.toThrow("24");
    expect(db().table("library_videos")).toHaveLength(24);
  });

  it("deletes only a draft with no views", async () => {
    seed();
    const gone = await create({ slug: "gone" });
    as(USERS.admin);
    await deleteLibraryDraft({ data: { videoId: gone } });
    expect(db().table("library_videos").some((v) => v.id === gone)).toBe(false);

    const live = await create({ slug: "live" });
    await publish(live);
    as(USERS.admin);
    await expect(deleteLibraryDraft({ data: { videoId: live } })).rejects.toThrow("Only a draft");
    await recordLibraryView({ data: { slug: "live" } });
    await move(live, "draft").catch(() => undefined);
    await move(live, "approved");
    await move(live, "draft");
    as(USERS.admin);
    await expect(deleteLibraryDraft({ data: { videoId: live } })).rejects.toThrow("view history");
  });

  it("checks the slug, link and cluster; a taken slug says so", async () => {
    seed();
    await create();
    await expect(create({ slug: "Bad Slug" })).rejects.toThrow("slug");
    await expect(create({ slug: "b", youtubeUrl: "https://evil.test/watch?v=dQw4w9WgXcQ" })).rejects.toThrow("YouTube");
    await expect(create({ slug: "c", clusterId: "nope" })).rejects.toThrow("cluster");
    await expect(create({ slug: "first-video" })).rejects.toThrow("already used");
    await expect(create({ title: " " })).rejects.toThrow("Missing title");
  });

  it("a YouTube link is stored in one form", async () => {
    seed();
    const id = await create({ youtubeUrl: "https://youtu.be/dQw4w9WgXcQ?si=abc" });
    expect(row(id).youtube_url).toBe(YT);
  });

  it("rename shows up publicly; the admin list has views and next steps", async () => {
    seed();
    const id = await create();
    as(USERS.admin);
    await renameLibraryCluster({ data: { clusterId: C1, name: "Getting started" } });
    as("");
    expect((await getPublicLibrary()).clusters[0]!.name).toBe("Getting started");
    await publish(id);
    await recordLibraryView({ data: { slug: "first-video" } });
    as(USERS.admin);
    const { videos, capacity } = await listLibraryForAdmin();
    expect(capacity).toBe(24);
    expect(videos[0]).toMatchObject({ views: 1, status: "published", nextStatuses: ["approved"], scriptText: "The script" });
  });
});

describe("views and attribution", () => {
  const live = async () => {
    const id = await create();
    await publish(id);
    as("");
    return id;
  };
  const events = () => db().table("library_view_events");

  it("a view stores the agent's token, with no sign-in", async () => {
    seed();
    const id = await live();
    expect(await recordLibraryView({ data: { slug: "first-video", tokens: [TOKEN] } })).toEqual({ logged: true });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ video_id: id, attribution_token_id: "tok-1" });
  });

  it("no token, an unknown one or a malformed one: still a view, with none", async () => {
    seed();
    await live();
    await recordLibraryView({ data: { slug: "first-video" } });
    await recordLibraryView({ data: { slug: "first-video", tokens: ["zzzzzzzzzzzz"] } });
    await recordLibraryView({ data: { slug: "first-video", tokens: ["<bad>"] } });
    expect(events()).toHaveLength(3);
    expect(events().every((e) => (e.attribution_token_id ?? null) === null)).toBe(true);
  });

  it("the first token wins; a revoked one isn't logged, and the next live one is", async () => {
    seed();
    await live();
    await recordLibraryView({ data: { slug: "first-video", tokens: [TOKEN, TOKEN2] } });
    expect(events().at(-1)!.attribution_token_id).toBe("tok-1");
    db().table("agent_attribution_tokens").find((t) => t.id === "tok-1")!.revoked_at = new Date().toISOString();
    await recordLibraryView({ data: { slug: "first-video", tokens: [TOKEN, TOKEN2] } });
    expect(events().at(-1)!.attribution_token_id).toBe("tok-2");
    await recordLibraryView({ data: { slug: "first-video", tokens: [TOKEN] } });
    expect(events().at(-1)!.attribution_token_id ?? null).toBeNull();
  });

  it("stores nothing about the visitor", async () => {
    seed();
    await live();
    await recordView(db() as never, { slug: "first-video", tokens: [TOKEN] });
    expect(Object.keys(events()[0]!).filter((k) => /user|ip|agent|email/.test(k) && k !== "attribution_token_id")).toEqual([]);
  });

  it("watching doesn't change the buyer, the stamp or any tether", async () => {
    seed();
    await live();
    const before = JSON.stringify(db().table("buyer_accounts"));
    await recordLibraryView({ data: { slug: "first-video", tokens: [TOKEN] } });
    expect(JSON.stringify(db().table("buyer_accounts"))).toBe(before);
    expect(db().table("buyer_attribution")).toEqual([]);
  });

  it("a bad address logs nothing", async () => {
    seed();
    expect(await recordLibraryView({ data: { slug: "../../admin" } })).toEqual({ logged: false });
    expect(await recordLibraryView({ data: { slug: "nope" } })).toEqual({ logged: false });
    expect(events()).toEqual([]);
  });
});

describe("links, slugs and embed code", () => {
  it("reads every normal YouTube link, and nothing else", () => {
    for (const ok of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtube.com/watch?v=dQw4w9WgXcQ&t=10", "https://m.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ", "https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"]) {
      expect(youtubeId(ok)).toBe("dQw4w9WgXcQ");
    }
    for (const bad of ["", null, "https://evil.test/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ", "https://evilyoutube.com/watch?v=dQw4w9WgXcQ", "javascript:alert(1)//dQw4w9WgXcQ", "https://www.youtube.com/watch?v=short", 'https://www.youtube.com/watch?v=dQw4w9WgXc"', "https://www.youtube.com/channel/dQw4w9WgXcQ", "not a link"]) {
      expect(youtubeId(bad)).toBeNull();
    }
    expect(youtubeEmbedUrl("dQw4w9WgXcQ")).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
  });

  it("makes clean slugs", () => {
    expect(slugify("What's a 1/8th Share?")).toBe("what-s-a-1-8th-share");
    expect(slugify("  Café  costs ")).toBe("cafe-costs");
    expect(isValidSlug(slugify("x".repeat(200)))).toBe(true);
    for (const bad of ["", "A", "a b", "-a", "a-", "a--b", "../a", "a/b"]) expect(isValidSlug(bad)).toBe(false);
  });

  it("embed code points at the embed page, title escaped", () => {
    const code = embedCode("https://divieight.test", "first", 'A "quoted" <title>');
    expect(code).toContain('src="https://divieight.test/embed/library/first"');
    expect(code).toContain('title="A &quot;quoted&quot; &lt;title&gt;"');
    expect(code).not.toContain("<title>");
  });

  it("search looks at titles and descriptions, ignoring case", () => {
    const videos = [{ title: "Costs", description: null }, { title: "Other", description: "about COSTS" }, { title: "Third", description: "x" }];
    expect(searchVideos(videos, " costs ").map((v) => v.title)).toEqual(["Costs", "Other"]);
    expect(searchVideos(videos, "")).toHaveLength(3);
  });
});

describe("the approver is never the creator", () => {
  it("the admin who created a video can't approve it, on the server, with a clear message; another admin can", async () => {
    seed();
    const id = await create();
    await move(id, "compliance_review");
    expect(row(id).created_by).toBe(USERS.admin);
    as(USERS.admin);
    await expect(moveLibraryVideo({ data: { videoId: id, status: "approved" } as never })).rejects.toThrow("approved by a different admin than the one who created it");
    expect(row(id).status).toBe("compliance_review");
    expect(row(id).compliance_approved_by ?? null).toBeNull();
    await move(id, "approved");
    expect(row(id).status).toBe("approved");
    expect(db().audits("library.video_approved")).toHaveLength(1);
  });

  it("a video from before the creator was recorded isn't blocked", async () => {
    seed();
    const id = await create();
    delete row(id).created_by;
    await move(id, "compliance_review");
    as(USERS.admin);
    await moveLibraryVideo({ data: { videoId: id, status: "approved" } as never });
    expect(row(id).status).toBe("approved");
  });

  it("the database refuses it too, and the rest of the compliance path is unchanged", () => {
    const sql = readFileSync("agents-library-decisions.sql", "utf8");
    expect(sql).toMatch(/compliance_approved_by = NEW.created_by/);
    expect(sql).toMatch(/different admin/);
  });
});
