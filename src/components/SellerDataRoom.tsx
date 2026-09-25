import { useCallback, useEffect, useRef, useState } from "react";
import { LISTING_LOCKED_MESSAGE } from "@/lib/listing-lock";
import { FileText, Trash2, Upload, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { logAudit } from "@/lib/audit";
import {
  DATA_ROOM_TYPES,
  DATA_ROOM_TYPE_HINTS,
  DATA_ROOM_TYPE_LABELS,
  formatUploadedAt,
  groupByType,
  normalizeType,
  type DataRoomDocument,
  type DataRoomDocumentType,
} from "@/lib/data-room";

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPTED = ["application/pdf", "image/jpeg", "image/png"];

/** Seller-side upload + management surface for a property's Virtual Data Room. */
export function SellerDataRoom({
  propertyId,
  sellerId,
  locked = false,
}: {
  propertyId: string;
  sellerId: string;
  /** Pod full — documents can be viewed but no longer added or removed. */
  locked?: boolean;
}) {
  const [docs, setDocs] = useState<DataRoomDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [docType, setDocType] = useState<DataRoomDocumentType>("inspection");
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("property_documents")
      .select("id, property_id, document_name, document_type, file_url, uploaded_at")
      .eq("property_id", propertyId)
      .order("uploaded_at", { ascending: false });
    setDocs((data ?? []) as DataRoomDocument[]);
    setLoading(false);
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    for (const file of Array.from(files)) {
      if (!ACCEPTED.includes(file.type)) {
        toast.error(`${file.name}: only PDF, JPG or PNG files are accepted.`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name}: files must be under 20MB.`);
        continue;
      }
      const ext = file.name.split(".").pop() ?? "pdf";
      const path = `${sellerId}/${propertyId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("property-documents")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) {
        toast.error(`${file.name}: upload failed.`);
        continue;
      }
      const { data: row, error } = await supabase
        .from("property_documents")
        .insert({
          property_id: propertyId,
          document_name: file.name,
          document_type: docType,
          file_url: path,
          uploaded_by: sellerId,
        })
        .select("id")
        .maybeSingle();
      if (error) {
        toast.error(`${file.name}: couldn't be saved.`);
        continue;
      }
      await logAudit({
        actorId: sellerId,
        actorType: "seller",
        actionType: "seller.data_room_document_uploaded",
        entityType: "property_document",
        entityId: row?.id ?? null,
        metadata: { property_id: propertyId, document_name: file.name, document_type: docType },
      });
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
    await load();
    toast.success("Data room updated.");
  }

  async function openDoc(doc: DataRoomDocument) {
    const { data, error } = await supabase.storage
      .from("property-documents")
      .createSignedUrl(doc.file_url, 60 * 60);
    if (error || !data?.signedUrl) {
      toast.error("Couldn't open that document.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function removeDoc(doc: DataRoomDocument) {
    const { error } = await supabase.from("property_documents").delete().eq("id", doc.id);
    if (error) {
      toast.error("Couldn't remove that document.");
      return;
    }
    await supabase.storage.from("property-documents").remove([doc.file_url]);
    await logAudit({
      actorId: sellerId,
      actorType: "seller",
      actionType: "seller.data_room_document_deleted",
      entityType: "property_document",
      entityId: doc.id,
      metadata: { property_id: propertyId, document_name: doc.document_name },
    });
    await load();
    toast.success("Document removed.");
  }

  const groups = groupByType(docs);

  return (
    <div className="mt-8 space-y-6">
      <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Upload diligence documents
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          These files are visible only to vetted buyers holding a Golden Ticket.
        </p>

        {locked ? (
          <p className="mt-4 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            {LISTING_LOCKED_MESSAGE}
          </p>
        ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Document type
            </span>
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value as DataRoomDocumentType)}
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {DATA_ROOM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {DATA_ROOM_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <span className="mt-1.5 block text-xs text-muted-foreground">
              {DATA_ROOM_TYPE_HINTS[docType]}
            </span>
          </label>

          <div className="flex items-end">
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".pdf,image/jpeg,image/png"
              onChange={(e) => void handleFiles(e.target.files)}
              className="hidden"
              id="data-room-file"
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              <Upload className="h-4 w-4" aria-hidden />
              {uploading ? "Uploading…" : "Choose files"}
            </button>
          </div>
        </div>
        )}
      </section>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading documents…</p>
      ) : groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No documents yet. Buyers will see an empty data room until you upload.
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.type}>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {DATA_ROOM_TYPE_LABELS[group.type]}
            </h3>
            <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              {group.docs.map((doc) => (
                <li
                  key={doc.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <FileText className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {doc.document_name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Uploaded {formatUploadedAt(doc.uploaded_at)} ·{" "}
                        {DATA_ROOM_TYPE_LABELS[normalizeType(doc.document_type)]}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void openDoc(doc)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
                    >
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                      View
                    </button>
                    {locked ? null : (
                    <button
                      type="button"
                      onClick={() => void removeDoc(doc)}
                      aria-label={`Remove ${doc.document_name}`}
                      className="inline-flex items-center rounded-lg border border-border bg-background p-1.5 text-muted-foreground transition hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
