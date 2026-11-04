import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MaintenancePhotos, MaintenanceStatusChip, MaintenanceTimeline, UrgentChip } from "@/components/owner/MaintenanceBits";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { formatDate } from "@/lib/format-date";
import { MAINTENANCE_CATEGORIES, maintenanceMoney, MAX_MAINTENANCE_PHOTO_BYTES, MAX_MAINTENANCE_PHOTOS, type MaintenanceUrgency } from "@/lib/maintenance";
import { getOwnerMaintenance, submitMaintenanceRequest } from "@/lib/maintenance.functions";
import type { OwnerMaintenanceRequest } from "@/lib/maintenance.server";

export const Route = createFileRoute("/owner/properties/$propertyId/maintenance")({
  head: () => ({
    meta: [
      { title: "Maintenance — divieight" },
      { name: "description", content: "Report and follow maintenance at your home." },
      { property: "og:title", content: "Maintenance — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerMaintenancePage,
});

const FIELD = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal";

function OwnerMaintenancePage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getOwnerMaintenance);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["owner-maintenance", propertyId, user?.id],
    enabled: !!user,
    retry: false,
    queryFn: () => load({ data: { propertyId } }),
  });

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/owner/login", search: { redirect: window.location.pathname } });
  }, [authLoading, user, navigate]);

  const denied = data?.allowed === false;
  useEffect(() => {
    if (!denied) return;
    toast.error("You don't have ownership in that property.");
    navigate({ to: "/owner" });
  }, [denied, navigate]);

  return (
    <OwnerPageShell>
      <Link to="/owner/properties/$propertyId" params={{ propertyId }} className="text-sm text-muted-foreground hover:text-foreground">
        ← Owner dashboard
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Maintenance</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Report an issue at the home. Every co-owner can see the requests here.</p>
      <div className="mt-6 space-y-6">
        {isError ? (
          <p className="text-sm text-muted-foreground">
            We couldn't load maintenance requests.{" "}
            <button type="button" onClick={() => void refetch()} className="font-medium text-primary hover:underline">
              Try again
            </button>
          </p>
        ) : authLoading || isLoading || !data || denied ? (
          <OwnerLoading />
        ) : (
          <>
            <RequestForm propertyId={propertyId} userId={user!.id} />
            <section>
              <h2 className="font-display text-lg font-semibold text-foreground">Requests</h2>
              <div className="mt-3 space-y-3">
                {data.requests.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No maintenance requests yet.</p>
                ) : (
                  data.requests.map((r) => <RequestCard key={r.id} request={r} />)
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </OwnerPageShell>
  );
}

function RequestForm({ propertyId, userId }: { propertyId: string; userId: string }) {
  const qc = useQueryClient();
  const submit = useServerFn(submitMaintenanceRequest);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(MAINTENANCE_CATEGORIES[0]!);
  const [urgency, setUrgency] = useState<MaintenanceUrgency>("normal");
  const [files, setFiles] = useState<File[]>([]);
  const [formKey, setFormKey] = useState(0);
  const mut = useMutation({
    mutationFn: async () => {
      if (files.length > MAX_MAINTENANCE_PHOTOS) throw new Error(`Attach up to ${MAX_MAINTENANCE_PHOTOS} photos.`);
      if (files.some((f) => f.size > MAX_MAINTENANCE_PHOTO_BYTES)) throw new Error("Each photo must be under 10 MB.");
      const photos: string[] = [];
      for (const file of files) {
        const ext = file.name.split(".").pop() ?? "jpg";
        const path = `${userId}/${propertyId}/maintenance-${crypto.randomUUID()}.${ext}`;
        const { error } = await supabase.storage.from("property-documents").upload(path, file, { contentType: file.type, upsert: false });
        if (error) throw new Error("Upload failed. Please try again.");
        photos.push(path);
      }
      return submit({ data: { propertyId, title, description, category, urgency, photos } });
    },
    onSuccess: (r) => {
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success("Request sent to the divieight Manager.");
      setTitle("");
      setDescription("");
      setUrgency("normal");
      setFiles([]);
      setFormKey((k) => k + 1); // clears the file input
      void qc.invalidateQueries({ queryKey: ["owner-maintenance", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    mut.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h2 className="font-display text-lg font-semibold text-foreground">Report an issue</h2>
      <label className="block text-sm font-medium text-foreground">
        Title
        <input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD} />
      </label>
      <label className="block text-sm font-medium text-foreground">
        What's wrong?
        <textarea required rows={3} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} className={FIELD} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-foreground">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={FIELD}>
            {MAINTENANCE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-foreground">
          Urgency
          <select value={urgency} onChange={(e) => setUrgency(e.target.value as MaintenanceUrgency)} className={FIELD}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="urgent">Urgent: co-owners are told right away</option>
          </select>
        </label>
      </div>
      <label className="block text-sm font-medium text-foreground">
        Photos (optional, up to {MAX_MAINTENANCE_PHOTOS})
        <input
          key={formKey}
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.webp,.heic"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="mt-1 block w-full text-sm font-normal text-muted-foreground"
        />
      </label>
      <button
        type="submit"
        disabled={!title.trim() || !description.trim() || mut.isPending}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {mut.isPending ? "Sending…" : "Send request"}
      </button>
    </form>
  );
}

function RequestCard({ request: r }: { request: OwnerMaintenanceRequest }) {
  return (
    <article className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-display text-base font-semibold text-foreground">{r.title}</h3>
        <div className="flex flex-wrap gap-1.5">
          <UrgentChip urgency={r.urgency} />
          <MaintenanceStatusChip status={r.status} />
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {r.category} · {formatDate(r.createdAt)} · {r.submittedByMe ? "Reported by you" : "Reported by a co-owner"}
      </p>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">{r.description}</p>
      <MaintenancePhotos urls={r.photoUrls} />
      {r.estimatedCost != null || r.actualCost != null || r.vendorName ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {[
            r.vendorName ? `Vendor: ${r.vendorName}` : null,
            r.estimatedCost != null ? `Estimate: ${maintenanceMoney(r.estimatedCost)}` : null,
            r.actualCost != null ? `Actual: ${maintenanceMoney(r.actualCost)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      <MaintenanceTimeline entries={r.timeline} />
    </article>
  );
}
