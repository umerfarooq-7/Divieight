import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { formatDate } from "@/lib/format-date";
import { RETENTION_EXCEPTION_LABELS, RETENTION_VOTE_DAYS, type RetentionExceptionStatus, type RetentionExceptionType } from "@/lib/retention";
import { getOwnerRetention, requestRetentionException, withdrawRetentionException } from "@/lib/retention.functions";
import type { OwnerRetentionShare } from "@/lib/retention.server";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/owner/properties/$propertyId/retention")({
  head: () => ({
    meta: [
      { title: "Retention Lock — divieight" },
      { name: "description", content: "Your shares' Retention Lock status and exception requests." },
      { property: "og:title", content: "Retention Lock — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerRetentionPage,
});

const MAX_DOC_BYTES = 20 * 1024 * 1024;

const STATUS_CHIP: Record<RetentionExceptionStatus, { label: string; className: string }> = {
  pending: { label: "In progress", className: "border-accent/50 bg-accent/10 text-accent" },
  approved: { label: "Approved", className: "border-primary/40 bg-primary/10 text-primary" },
  rejected: { label: "Rejected", className: "border-destructive/40 text-destructive" },
  withdrawn: { label: "Withdrawn", className: "border-border text-muted-foreground" },
};

function OwnerRetentionPage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getOwnerRetention);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["owner-retention", propertyId, user?.id],
    enabled: !!user,
    retry: false,
    queryFn: () => load({ data: { propertyId } }),
  });

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/buyer/login" });
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
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Retention Lock</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        A share can't be listed for resale until 12 months after closing, unless an exception is approved.
      </p>
      <div className="mt-6 space-y-4">
        {isError ? (
          <p className="text-sm text-muted-foreground">
            We couldn't load your shares.{" "}
            <button type="button" onClick={() => void refetch()} className="font-medium text-primary hover:underline">
              Try again
            </button>
          </p>
        ) : authLoading || isLoading || !data || denied ? (
          <OwnerLoading />
        ) : (
          data.shares.map((share) => <ShareCard key={share.shareNumber} propertyId={propertyId} share={share} userId={user!.id} />)
        )}
      </div>
    </OwnerPageShell>
  );
}

function ShareCard({ propertyId, share, userId }: { propertyId: string; share: OwnerRetentionShare; userId: string }) {
  const [requesting, setRequesting] = useState(false);
  const Icon = share.locked ? Lock : LockOpen;
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold text-foreground">
            <Icon className="h-4 w-4 text-accent" aria-hidden /> Share #{share.shareNumber}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {share.locked
              ? `Locked until ${formatDate(share.expiresAt)}: ${share.daysRemaining} day${share.daysRemaining === 1 ? "" : "s"} remaining.`
              : share.exceptionApproved
                ? "Released by an approved exception. It can be listed for resale."
                : `Lock ended ${formatDate(share.expiresAt)}. It can be listed for resale.`}
            {share.locked && !share.started ? " The lock starts at closing, so this date may change." : ""}
          </p>
        </div>
        {share.canRequest && !requesting ? (
          <button
            type="button"
            onClick={() => setRequesting(true)}
            className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary"
          >
            Request exception
          </button>
        ) : null}
      </div>
      {requesting ? <RequestForm propertyId={propertyId} shareNumber={share.shareNumber} userId={userId} onDone={() => setRequesting(false)} /> : null}
      {share.requests.length > 0 ? (
        <ul className="mt-4 space-y-3 border-t border-border pt-4">
          {share.requests.map((r) => (
            <RequestItem key={r.id} propertyId={propertyId} request={r} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function RequestForm({ propertyId, shareNumber, userId, onDone }: { propertyId: string; shareNumber: number; userId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const submit = useServerFn(requestRetentionException);
  const [exceptionType, setExceptionType] = useState<RetentionExceptionType>("hardship");
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const mut = useMutation({
    mutationFn: async () => {
      let supportingDocUrl: string | null = null;
      if (file) {
        if (file.size > MAX_DOC_BYTES) throw new Error("That file is over 20 MB.");
        const ext = file.name.split(".").pop() ?? "pdf";
        const path = `${userId}/${propertyId}/retention-${crypto.randomUUID()}.${ext}`;
        const { error } = await supabase.storage.from("property-documents").upload(path, file, { contentType: file.type, upsert: false });
        if (error) throw new Error("Upload failed. Please try again.");
        supportingDocUrl = path;
      }
      return submit({ data: { propertyId, shareNumber, exceptionType, reason, supportingDocUrl } });
    },
    onSuccess: (r) => {
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success(r.voteId ? "Vote opened. Remember to cast your own ballot." : "Request sent to the divieight Manager.");
      onDone();
      void qc.invalidateQueries({ queryKey: ["owner-retention", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <form
      className="mt-4 space-y-4 border-t border-border pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        mut.mutate();
      }}
    >
      <fieldset>
        <legend className="text-sm font-medium text-foreground">Exception type</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {(Object.keys(RETENTION_EXCEPTION_LABELS) as RetentionExceptionType[]).map((type) => (
            <label
              key={type}
              className={cn("cursor-pointer rounded-lg border p-3 text-sm", exceptionType === type ? "border-primary bg-primary/5" : "border-border")}
            >
              <span className="flex items-center gap-2 font-medium text-foreground">
                <input type="radio" name={`type-${shareNumber}`} checked={exceptionType === type} onChange={() => setExceptionType(type)} />
                {RETENTION_EXCEPTION_LABELS[type]}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {type === "hardship"
                  ? "The divieight Manager reviews your request."
                  : `Opens a ${RETENTION_VOTE_DAYS}-day vote. Every issued share must vote Yes, including yours. Co-owners will see your reason.`}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-sm font-medium text-foreground">
        Reason
        <textarea
          required
          rows={3}
          maxLength={5000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal"
        />
      </label>
      <label className="block text-sm font-medium text-foreground">
        Supporting document (optional)
        <input
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm font-normal text-muted-foreground"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={!reason.trim() || mut.isPending}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {mut.isPending ? "Sending…" : "Send request"}
        </button>
        <button type="button" onClick={onDone} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

function RequestItem({ propertyId, request: r }: { propertyId: string; request: OwnerRetentionShare["requests"][number] }) {
  const qc = useQueryClient();
  const withdraw = useServerFn(withdrawRetentionException);
  const mut = useMutation({
    mutationFn: () => withdraw({ data: { exceptionId: r.id } }),
    onSuccess: (res) => {
      if (res.error) toast.error(res.error);
      else toast.success("Request withdrawn.");
      void qc.invalidateQueries({ queryKey: ["owner-retention", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const chip = STATUS_CHIP[r.status];
  return (
    <li className="text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-foreground">
          {RETENTION_EXCEPTION_LABELS[r.exceptionType]} · {formatDate(r.createdAt)}
        </span>
        <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", chip.className)}>{chip.label}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{r.reason}</p>
      {r.hasDocument ? <p className="mt-1 text-xs text-muted-foreground">Document attached.</p> : null}
      {r.decisionNote ? <p className="mt-1 text-xs text-foreground">Decision: {r.decisionNote}</p> : null}
      {r.status === "pending" ? (
        <div className="mt-2 flex flex-wrap gap-3 text-sm font-medium">
          {r.voteId ? (
            <Link to="/owner/properties/$propertyId/votes/$voteId" params={{ propertyId, voteId: r.voteId }} className="text-primary hover:underline">
              Open the vote
            </Link>
          ) : null}
          <button type="button" disabled={mut.isPending} onClick={() => mut.mutate()} className="text-muted-foreground hover:text-foreground disabled:opacity-50">
            Withdraw
          </button>
        </div>
      ) : null}
    </li>
  );
}
