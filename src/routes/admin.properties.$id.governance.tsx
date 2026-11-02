import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDate } from "@/lib/format-date";
import {
  deleteGovernanceRule,
  getAdminGovernance,
  postOwnerNotice,
  saveGovernanceRule,
  type GovernanceRule,
} from "@/lib/owner-llc.functions";

export const Route = createFileRoute("/admin/properties/$id/governance")({
  head: () => ({
    meta: [
      { title: "Governance & notices — divieight admin" },
      { name: "description", content: "Edit a property's governance rules and post notices to its owners." },
      { property: "og:title", content: "Governance & notices — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminGovernance,
});

const FIELD = "block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
const QUERY_KEY = "admin-governance";

function AdminGovernance() {
  const { id } = Route.useParams();
  const load = useServerFn(getAdminGovernance);
  const { data, isLoading, error } = useQuery({
    queryKey: [QUERY_KEY, id],
    retry: false,
    queryFn: () => load({ data: { propertyId: id } }),
  });

  return (
    <div>
      <Link to="/admin/properties" className="text-sm text-muted-foreground hover:text-foreground">
        ← Properties
      </Link>
      <h1 className="mt-3 font-display text-2xl font-semibold text-foreground">Governance &amp; notices</h1>
      {data ? <p className="mt-1 text-sm text-muted-foreground">{data.label}</p> : null}
      {isLoading ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="mt-6 text-sm text-destructive">{error.message}</p>
      ) : data ? (
        <div className="mt-6 space-y-8">
          <section>
            <h2 className="text-sm font-semibold text-foreground">Governance rules</h2>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
              Editing a default saves a copy for this property only; other properties keep the default.
            </p>
            <div className="mt-3 space-y-3">
              {data.rules.map((r) => (
                <RuleEditor key={r.id} propertyId={id} rule={r} />
              ))}
              <RuleEditor propertyId={id} rule={null} />
            </div>
          </section>
          <section>
            <h2 className="text-sm font-semibold text-foreground">Notices to owners</h2>
            <NoticeForm propertyId={id} />
            <ul className="mt-3 space-y-2">
              {data.notices.map((n) => (
                <li key={n.id} className="rounded-lg border border-border bg-card p-3 text-sm">
                  <p className="font-medium text-foreground">
                    {n.title} <span className="ml-1 text-xs font-normal text-muted-foreground">{formatDate(n.created_at)}</span>
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{n.body}</p>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function RuleEditor({ propertyId, rule }: { propertyId: string; rule: GovernanceRule | null }) {
  const qc = useQueryClient();
  const save = useServerFn(saveGovernanceRule);
  const remove = useServerFn(deleteGovernanceRule);
  const [title, setTitle] = useState(rule?.title ?? "");
  const [body, setBody] = useState(rule?.body ?? "");
  const [sortOrder, setSortOrder] = useState(String(rule?.sort_order ?? 0));
  const refresh = () => qc.invalidateQueries({ queryKey: [QUERY_KEY, propertyId] });

  const saveMut = useMutation({
    mutationFn: () =>
      save({ data: { propertyId, sectionKey: rule?.section_key ?? null, title, body, sortOrder: Number(sortOrder) || 0 } }),
    onSuccess: () => {
      toast.success("Rule saved.");
      if (!rule) {
        setTitle("");
        setBody("");
        setSortOrder("0");
      }
      void refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeMut = useMutation({
    mutationFn: () => remove({ data: { propertyId, sectionKey: rule!.section_key } }),
    onSuccess: () => {
      toast.success("Removed from this property.");
      void refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {!rule ? "Add a rule" : rule.property_id ? "This property" : "Default"}
        </span>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Order
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          />
        </label>
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Rule title" className={FIELD} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Text" aria-label="Rule text" className={FIELD} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saveMut.isPending || !title.trim() || !body.trim()}
          onClick={() => saveMut.mutate()}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {!rule ? "Add rule" : rule.property_id ? "Save" : "Save for this property"}
        </button>
        {rule?.property_id ? (
          <button
            type="button"
            disabled={removeMut.isPending}
            onClick={() => removeMut.mutate()}
            className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground disabled:opacity-50"
          >
            Remove from this property
          </button>
        ) : null}
      </div>
    </div>
  );
}

function NoticeForm({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const post = useServerFn(postOwnerNotice);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const mut = useMutation({
    mutationFn: () => post({ data: { propertyId, title, body } }),
    onSuccess: () => {
      toast.success("Notice posted.");
      setTitle("");
      setBody("");
      void qc.invalidateQueries({ queryKey: [QUERY_KEY, propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-border bg-card p-4">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Notice title" aria-label="Notice title" className={FIELD} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Notice text" aria-label="Notice text" className={FIELD} />
      <button
        type="button"
        disabled={mut.isPending || !title.trim() || !body.trim()}
        onClick={() => mut.mutate()}
        className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {mut.isPending ? "Posting…" : "Post notice"}
      </button>
    </div>
  );
}
