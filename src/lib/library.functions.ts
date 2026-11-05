import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { LIBRARY_NEXT, type LibraryStatus } from "@/lib/library";
import type { VideoInput } from "@/lib/library.server";

/** Callable surface for the Buyer Learning Library. */

type Db = { from: (t: string) => any };

async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
  return supabaseAdmin as unknown as Db;
}

async function server() {
  return import("@/lib/library.server");
}

async function requireAdmin(context: { supabase: any; userId: string }) {
  const { data } = await context.supabase.rpc("has_role", { _user_id: context.userId, _role: "admin" });
  if (!data) throw new Error("Not authorized");
}

const required = (value: unknown, label: string, max: number) => {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`Missing ${label}`);
  return text.slice(0, max);
};
const optional = (value: unknown, max: number) => {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
};

const videoInput = (input: Partial<Record<keyof VideoInput, unknown>> | undefined): VideoInput => {
  const sort = Number(input?.sortOrder ?? 0);
  return {
    clusterId: required(input?.clusterId, "cluster", 64),
    title: required(input?.title, "title", 200),
    slug: required(input?.slug, "slug", 80),
    description: optional(input?.description, 2000),
    youtubeUrl: optional(input?.youtubeUrl, 500),
    scriptText: optional(input?.scriptText, 50000),
    sortOrder: Number.isFinite(sort) ? Math.trunc(sort) : 0,
  };
};

// Public: no sign-in, published videos only.

export const getPublicLibrary = createServerFn({ method: "GET" }).handler(async () => (await server()).publicLibrary(await adminDb()));

export const getPublicVideo = createServerFn({ method: "GET" })
  .inputValidator((input: { slug: string }) => ({ slug: String(input?.slug ?? "").slice(0, 100) }))
  .handler(async ({ data }) => (await server()).publicVideoBySlug(await adminDb(), data.slug));

export const recordLibraryView = createServerFn({ method: "POST" })
  .inputValidator((input: { slug: string; tokens?: string[] }) => ({
    slug: String(input?.slug ?? "").slice(0, 100),
    tokens: (Array.isArray(input?.tokens) ? input.tokens : []).map(String).slice(0, 5),
  }))
  .handler(async ({ data }) => {
    try {
      return await (await server()).recordView(await adminDb(), data);
    } catch {
      return { logged: false }; // watching never fails because logging did
    }
  });

// Admin.

export const listLibraryForAdmin = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context);
    return (await server()).adminLibrary(await adminDb());
  });

export const createLibraryVideo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(videoInput)
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).createVideo(await adminDb(), { adminId: context.userId, input: data });
  });

export const updateLibraryVideo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { videoId: string; input: VideoInput }) => ({ videoId: required(input?.videoId, "video", 64), input: videoInput(input?.input) }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    return (await server()).updateVideo(await adminDb(), { adminId: context.userId, ...data });
  });

export const moveLibraryVideo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { videoId: string; status: LibraryStatus }) => {
    if (!(input?.status in LIBRARY_NEXT)) throw new Error("Choose a status");
    return { videoId: required(input?.videoId, "video", 64), status: input.status };
  })
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).moveVideo(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });

export const deleteLibraryDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { videoId: string }) => ({ videoId: required(input?.videoId, "video", 64) }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).deleteDraft(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });

export const renameLibraryCluster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { clusterId: string; name: string }) => ({ clusterId: required(input?.clusterId, "cluster", 64), name: required(input?.name, "name", 100) }))
  .handler(async ({ data, context }) => {
    await requireAdmin(context);
    await (await server()).renameCluster(await adminDb(), { adminId: context.userId, ...data });
    return { ok: true };
  });
