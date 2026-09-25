import { useCallback, useEffect, useState } from "react";
import { ListingLockGuard } from "@/components/ListingLockGuard";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CurrencyInput } from "@/components/CurrencyInput";
import { submitListingForApproval } from "@/lib/listing-approval.functions";

/**
 * Seller edit screen limited to the property itself — address, facts, price,
 * description and photos. Agreement, Listing Agent choice and the review
 * gates are deliberately NOT part of this screen; it is where a seller lands
 * after a Listing Agent rejects the property with a reason.
 */
export const Route = createFileRoute("/listings/$id/edit")({
  head: () => ({
    meta: [
      { title: "Edit property details — divieight" },
      {
        name: "description",
        content: "Update your property address, facts, photos and description, then resubmit for review.",
      },
      { property: "og:title", content: "Edit property details — divieight" },
      {
        property: "og:description",
        content: "Update your divieight property details and resubmit for Listing Agent review.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: EditPropertyScreenGuarded,
});

type Photo = { id: string; path: string; url: string; caption: string };

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function EditPropertyScreenGuarded() {
  const { id: propertyId } = Route.useParams();
  return (
    <ListingLockGuard propertyId={propertyId}>
      <EditPropertyScreen />
    </ListingLockGuard>
  );
}

function EditPropertyScreen() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  const [loadingData, setLoadingData] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [form, setForm] = useState({
    address: "",
    city: "",
    state: "",
    zip: "",
    property_type: "",
    bedrooms: "",
    bathrooms: "",
    square_footage: "",
    listing_price: "",
    description: "",
  });

  const load = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from("properties")
      .select(
        "id, seller_id, address, city, state, zip, property_type, bedrooms, bathrooms, square_footage, listing_price, description, listing_rejection_reason",
      )
      .eq("id", id)
      .eq("seller_id", user.id)
      .maybeSingle();
    if (error || !data) {
      toast.error("Property not found.");
      navigate({ to: "/dashboard" });
      return;
    }
    const p = data as unknown as Record<string, unknown>;
    setRejectionReason((p["listing_rejection_reason"] as string | null) ?? null);
    setForm({
      address: (p["address"] as string) ?? "",
      city: (p["city"] as string) ?? "",
      state: (p["state"] as string) ?? "",
      zip: (p["zip"] as string) ?? "",
      property_type: (p["property_type"] as string) ?? "",
      bedrooms: p["bedrooms"] == null ? "" : String(p["bedrooms"]),
      bathrooms: p["bathrooms"] == null ? "" : String(p["bathrooms"]),
      square_footage: p["square_footage"] == null ? "" : String(p["square_footage"]),
      listing_price: p["listing_price"] == null ? "" : String(p["listing_price"]),
      description: (p["description"] as string) ?? "",
    });

    const { data: media } = await supabase
      .from("property_media")
      .select("id, url, caption, display_order, media_type")
      .eq("property_id", id)
      .eq("media_type", "photo")
      .order("display_order", { ascending: true });
    const rows = (media ?? []) as { id: string; url: string; caption: string | null }[];
    if (rows.length > 0) {
      const { data: signed } = await supabase.storage
        .from("property-media")
        .createSignedUrls(rows.map((m) => m.url), 60 * 60);
      const byPath = new Map<string, string>();
      (signed ?? []).forEach((s) => {
        if (s.path && s.signedUrl) byPath.set(s.path, s.signedUrl);
      });
      setPhotos(
        rows.map((m) => ({
          id: m.id,
          path: m.url,
          url: byPath.get(m.url) ?? "",
          caption: m.caption ?? "",
        })),
      );
    } else {
      setPhotos([]);
    }
    setLoadingData(false);
  }, [id, user, navigate]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/login" });
      return;
    }
    void load();
  }, [user, loading, load, navigate]);

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const path = `${id}/${randomId()}-${Date.now()}.${ext}`;
        const { error } = await supabase.storage
          .from("property-media")
          .upload(path, file, { contentType: file.type, upsert: false });
        if (error) {
          toast.error(`Couldn't upload ${file.name}.`);
          continue;
        }
        await supabase.from("property_media").insert({
          property_id: id,
          url: path,
          media_type: "photo",
          display_order: photos.length,
          caption: "",
        });
      }
      await load();
      toast.success("Photos added.");
    } finally {
      setUploading(false);
    }
  }

  async function removePhoto(photo: Photo) {
    await supabase.from("property_media").delete().eq("id", photo.id);
    await supabase.storage.from("property-media").remove([photo.path]);
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
  }

  async function save(resubmit: boolean) {
    if (!form.address.trim() || !form.city.trim() || !form.state.trim()) {
      toast.error("Address, city and state are required.");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("properties")
        .update({
          address: form.address.trim(),
          city: form.city.trim(),
          state: form.state.trim(),
          zip: form.zip.trim(),
          property_type: form.property_type.trim() || null,
          bedrooms: form.bedrooms ? Number(form.bedrooms) : null,
          bathrooms: form.bathrooms ? Number(form.bathrooms) : null,
          square_footage: form.square_footage ? Number(form.square_footage) : null,
          listing_price: form.listing_price ? Number(form.listing_price) : null,
          description: form.description.trim() || null,
        })
        .eq("id", id);
      if (error) throw error;

      for (const p of photos) {
        await supabase.from("property_media").update({ caption: p.caption }).eq("id", p.id);
      }

      if (resubmit) {
        await submitListingForApproval({ data: { propertyId: id } });
        toast.success("Sent back to your Listing Agent for review.");
        navigate({ to: "/dashboard" });
        return;
      }
      toast.success("Property details saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save your changes.");
    } finally {
      setSaving(false);
    }
  }

  if (loading || loadingData) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-muted-foreground">
        Loading your property…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
        Edit property details
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Update the property itself — address, facts, photos and description.
      </p>

      {rejectionReason && (
        <div className="mt-6 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
          <p className="text-sm font-medium text-foreground">Your Listing Agent asked for changes</p>
          <p className="mt-1 text-sm text-muted-foreground">{rejectionReason}</p>
        </div>
      )}

      <div className="mt-8 space-y-6 rounded-xl border border-border bg-card p-6">
        <div>
          <label className="text-sm font-medium text-foreground">Street address</label>
          <Input
            className="mt-1"
            value={form.address}
            onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-sm font-medium text-foreground">City</label>
            <Input
              className="mt-1"
              value={form.city}
              onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">State</label>
            <Input
              className="mt-1"
              value={form.state}
              onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">ZIP</label>
            <Input
              className="mt-1"
              value={form.zip}
              onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))}
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <div>
            <label className="text-sm font-medium text-foreground">Property type</label>
            <Input
              className="mt-1"
              value={form.property_type}
              onChange={(e) => setForm((f) => ({ ...f, property_type: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">Bedrooms</label>
            <Input
              className="mt-1"
              inputMode="numeric"
              value={form.bedrooms}
              onChange={(e) => setForm((f) => ({ ...f, bedrooms: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">Bathrooms</label>
            <Input
              className="mt-1"
              inputMode="decimal"
              value={form.bathrooms}
              onChange={(e) => setForm((f) => ({ ...f, bathrooms: e.target.value }))}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">Square footage</label>
            <Input
              className="mt-1"
              inputMode="numeric"
              value={form.square_footage}
              onChange={(e) => setForm((f) => ({ ...f, square_footage: e.target.value }))}
            />
          </div>
        </div>
        <CurrencyInput
          label="Listing price"
          value={form.listing_price}
          onValueChange={(v) => setForm((f) => ({ ...f, listing_price: v }))}
        />
        <div>
          <label className="text-sm font-medium text-foreground">Description</label>
          <Textarea
            className="mt-1"
            rows={6}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-border bg-card p-6">
        <h2 className="font-display text-lg font-semibold text-foreground">Photos</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {photos.map((p) => (
            <div key={p.id} className="rounded-lg border border-border p-3">
              {p.url && (
                <img
                  src={p.url}
                  alt={p.caption || "Property photo"}
                  loading="lazy"
                  className="h-40 w-full rounded-md object-cover"
                />
              )}
              <Input
                className="mt-2"
                value={p.caption}
                placeholder="Caption"
                onChange={(e) =>
                  setPhotos((prev) =>
                    prev.map((x) => (x.id === p.id ? { ...x, caption: e.target.value } : x)),
                  )
                }
              />
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                onClick={() => void removePhoto(p)}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
        <label className="mt-4 inline-flex h-9 cursor-pointer items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-muted">
          {uploading ? "Uploading…" : "Add photos"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            onChange={(e) => void addFiles(e.target.files)}
          />
        </label>
      </div>

      <div className="mt-6 flex flex-wrap justify-between gap-3">
        <Button variant="outline" onClick={() => navigate({ to: "/dashboard" })}>
          Back to dashboard
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={saving} onClick={() => void save(false)}>
            Save changes
          </Button>
          <Button disabled={saving} onClick={() => void save(true)}>
            Save &amp; resubmit for review
          </Button>
        </div>
      </div>
    </div>
  );
}
