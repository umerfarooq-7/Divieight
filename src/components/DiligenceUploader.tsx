import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, FileText, Upload } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import {
  ADMIN_DD_CATEGORIES,
  AUTO_GOVERNING_CATEGORIES,
  DD_CATEGORY_LABELS,
  formatDate,
  hashFile,
  type DdCategory,
} from "@/lib/due-diligence";
import {
  listPropertyDiligence,
  placeDiligenceDocument,
  placeSellerDisclosure,
  type PropertyDdDocument,
} from "@/lib/due-diligence.functions";
import { supabase } from "@/integrations/supabase/client";

const MAX_BYTES = 20 * 1024 * 1024;
const ACCEPTED = ["application/pdf", "image/jpeg", "image/png"];

/**
 * Upload surface feeding the Due Diligence Inventory. Admins place any
 * category except the Seller's Disclosure; sellers place disclosures only.
 */
export function DiligenceUploader({
  propertyId,
  mode,
}: {
  propertyId: string;
  mode: "admin" | "seller";
}) {
  const list = useServerFn(listPropertyDiligence);
  const placeAdmin = useServerFn(placeDiligenceDocument);
  const placeSeller = useServerFn(placeSellerDisclosure);

  const [documents, setDocuments] = useState<PropertyDdDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(true);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<DdCategory>("inspection");
  const [required, setRequired] = useState(true);
  const [governing, setGoverning] = useState(false);
  const [governingTouched, setGoverningTouched] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<PropertyDdDocument | null>(null);
  const [confirming, setConfirming] = useState<PropertyDdDocument | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A replace target or document list from another property must never carry
  // over: clear on property change, and drop responses for an older property.
  const currentProperty = useRef(propertyId);
  currentProperty.current = propertyId;
  useEffect(() => {
    setDocuments([]);
    setLoading(true);
    setReplaceTarget(null);
    setConfirming(null);
  }, [propertyId]);

  const load = useCallback(async () => {
    const requested = propertyId;
    const res = await list({ data: { propertyId: requested } });
    if (currentProperty.current !== requested) return;
    setAllowed(res.allowed);
    setDocuments(res.documents);
    setLoading(false);
  }, [list, propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  function pickCategory(next: DdCategory) {
    setCategory(next);
    if (!governingTouched) setGoverning(AUTO_GOVERNING_CATEGORIES.includes(next));
  }

  function reset() {
    setTitle("");
    setFile(null);
    setRequired(true);
    setGoverning(false);
    setGoverningTouched(false);
    setReplaceTarget(null);
    setConfirming(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function matchingDocument(): PropertyDdDocument | null {
    const t = title.trim().toLowerCase();
    return (
      documents.find(
        (d) => !d.superseded_by && d.document_title.trim().toLowerCase() === t,
      ) ?? null
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      toast.error("Choose a file to upload.");
      return;
    }
    if (!title.trim()) {
      toast.error("Give the document a title.");
      return;
    }
    if (!ACCEPTED.includes(file.type)) {
      toast.error("Only PDF, JPG or PNG files are accepted.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("Files must be under 20MB.");
      return;
    }
    const existing = matchingDocument();
    if (existing && !replaceTarget) {
      setConfirming(existing);
      return;
    }
    void upload(replaceTarget?.id ?? null);
  }

  async function upload(supersedesId: string | null) {
    if (!file) return;
    setBusy(true);
    setConfirming(null);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) {
        toast.error("Your session expired — sign in again.");
        return;
      }
      const ext = file.name.split(".").pop() ?? "pdf";
      const path = `${uid}/${propertyId}/diligence-${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("property-documents")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) {
        toast.error("Upload failed — try again.");
        return;
      }
      const contentHash = await hashFile(file);
      const res =
        mode === "admin"
          ? await placeAdmin({
              data: {
                propertyId,
                documentTitle: title.trim(),
                category,
                fileUrl: path,
                contentHash,
                required,
                isGoverningInstrument: governing,
                supersedesId,
              },
            })
          : await placeSeller({
              data: {
                propertyId,
                documentTitle: title.trim(),
                fileUrl: path,
                contentHash,
                supersedesId,
              },
            });
      if (!res.ok) {
        toast.error(res.error ?? "Couldn't save that document.");
        return;
      }
      toast.success(
        supersedesId
          ? "Replacement placed — acknowledgments reset to the new version."
          : "Document placed in the inventory.",
      );
      reset();
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading inventory…</p>;
  if (!allowed)
    return (
      <p className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
        You don't have access to this property's due-diligence inventory.
      </p>
    );

  const current = documents.filter((d) => !d.superseded_by);
  const superseded = documents.filter((d) => d.superseded_by);

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleSubmit}
        className="rounded-xl border border-border bg-card p-6 shadow-sm"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {mode === "admin" ? "Place a due-diligence document" : "Property Disclosure Documents"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === "admin"
            ? "Buyer Accounts reserved into this property and their tethered Resident Agents are notified when a required document is placed."
            : "Disclosure documents for the due-diligence inventory. This is separate from your Supporting Documentation uploads."}
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Document title
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Seller's Disclosure — 2026"
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>

          {mode === "admin" ? (
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Category
              </span>
              <select
                value={category}
                onChange={(e) => pickCategory(e.target.value as DdCategory)}
                className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
              >
                {ADMIN_DD_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {DD_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div>
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Category
              </span>
              <p className="mt-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                Seller's Disclosure
              </p>
            </div>
          )}

          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              File (PDF, JPG or PNG)
            </span>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,image/jpeg,image/png"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>

          {mode === "admin" ? (
            <div className="sm:col-span-2 flex flex-wrap gap-6">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={required}
                  onChange={(e) => setRequired(e.target.checked)}
                  className="h-4 w-4"
                />
                Required — gates Buyer Authorization
              </label>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={governing}
                  onChange={(e) => {
                    setGoverningTouched(true);
                    setGoverning(e.target.checked);
                  }}
                  className="h-4 w-4"
                />
                Governing instrument — show the Independent-Review Notice
              </label>
            </div>
          ) : (
            <p className="sm:col-span-2 text-xs text-muted-foreground">
              Disclosures are always required and are never governing instruments.
            </p>
          )}
        </div>

        {confirming ? (
          <div className="mt-4 rounded-lg border border-accent/40 bg-accent/5 p-4">
            <p className="text-sm text-foreground">
              This looks like an update to “{confirming.document_title}” — is this a replacement?
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setReplaceTarget(confirming);
                  void upload(confirming.id);
                }}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
              >
                Yes — replace it
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void upload(null)}
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground disabled:opacity-60"
              >
                No — place as a separate document
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="rounded-lg px-3 py-2 text-sm text-muted-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="submit"
            disabled={busy}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
          >
            <Upload className="h-4 w-4" aria-hidden />
            {busy ? "Placing…" : "Place document"}
          </button>
        )}
      </form>

      <DocList title="Current inventory" docs={current} empty="No documents placed yet." />
      {superseded.length > 0 ? (
        <DocList title="Superseded versions" docs={superseded} empty="" />
      ) : null}
    </div>
  );
}

function DocList({
  title,
  docs,
  empty,
}: {
  title: string;
  docs: PropertyDdDocument[];
  empty: string;
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {docs.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <FileText className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {d.document_title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {DD_CATEGORY_LABELS[d.category]} · placed {formatDate(d.placed_at)}
                    {d.required ? " · required" : " · optional"}
                    {d.is_governing_instrument ? " · governing instrument" : ""}
                  </p>
                </div>
              </div>
              {d.signed_url ? (
                <a
                  href={d.signed_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  View
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
