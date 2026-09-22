/**
 * Resolves `property-media` storage paths to browser-renderable URLs.
 *
 * Prefers 1-hour signed URLs via the service-role client. Any path that
 * can't be signed (service-role key missing/invalid, signing error) falls
 * back to the bucket's public URL — `property-media` is a public bucket,
 * so photos keep rendering even when server secrets are misconfigured.
 */
export async function resolvePropertyMediaUrls(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
    const { data: signed, error } = await supabaseAdmin.storage
      .from("property-media")
      .createSignedUrls(paths, 60 * 60);
    if (error) console.error("[property-media] signing failed:", error.message);
    (signed ?? []).forEach((s) => {
      if (s.path && s.signedUrl) out.set(s.path, s.signedUrl);
    });
  } catch (err) {
    console.error("[property-media] signing unavailable:", err instanceof Error ? err.message : err);
  }

  const base = process.env.SUPABASE_URL;
  if (base) {
    for (const path of paths) {
      if (!out.has(path)) {
        const encoded = path.split("/").map(encodeURIComponent).join("/");
        out.set(path, `${base}/storage/v1/object/public/property-media/${encoded}`);
      }
    }
  }
  return out;
}
