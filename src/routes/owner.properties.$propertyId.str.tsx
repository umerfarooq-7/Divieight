import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { formatCents } from "@/lib/bank-feed-display";
import { LODGING_TAX_LABELS, LODGING_TAX_STATUSES, OWNER_STR_NOTICE, strRecordProblem, type LodgingTaxStatus } from "@/lib/str";
import { deleteStrRecordFn, getOwnerStr, saveStrRecordFn } from "@/lib/str.functions";

export const Route = createFileRoute("/owner/properties/$propertyId/str")({
  head: () => ({
    meta: [
      { title: "Short-term rental records — divieight" },
      { name: "description", content: "Your own short-term-rental activity, kept for your own records." },
      { property: "og:title", content: "Short-term rental records — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerStrPage,
});

const FIELD = "mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm";
const PRIMARY = "inline-flex min-h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50";
const SECONDARY = "inline-flex min-h-9 items-center rounded-md border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50";
const toCents = (t: string) => Math.round(Number(t.replace(/[$,\s]/g, "")) * 100);

function OwnerStrPage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const load = useServerFn(getOwnerStr);
  const save = useServerFn(saveStrRecordFn);
  const remove = useServerFn(deleteStrRecordFn);
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ["owner-str", propertyId, user?.id], enabled: !!user, retry: false, queryFn: () => load({ data: { propertyId } }) });

  const [editing, setEditing] = useState<string | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [nights, setNights] = useState("");
  const [gross, setGross] = useState("");
  const [fees, setFees] = useState("0");
  const [status, setStatus] = useState<LodgingTaxStatus>("unknown");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/owner/login", search: { redirect: window.location.pathname } });
  }, [authLoading, user, navigate]);
  const denied = data?.allowed === false;
  useEffect(() => {
    if (!denied) return;
    toast.error("You don't have ownership in that property.");
    navigate({ to: "/owner" });
  }, [denied, navigate]);

  const draft = { periodStart: start, periodEnd: end, nights: Number(nights), grossCents: toCents(gross || "0"), feesCents: toCents(fees || "0"), lodgingTaxStatus: status };
  const problem = strRecordProblem(draft);
  const reset = () => {
    setEditing(null);
    setStart("");
    setEnd("");
    setNights("");
    setGross("");
    setFees("0");
    setStatus("unknown");
    setNote("");
  };
  const refresh = () => void qc.invalidateQueries({ queryKey: ["owner-str", propertyId] });
  const fail = (e: Error) => toast.error(e.message);
  const saveM = useMutation({
    mutationFn: () => save({ data: { propertyId, id: editing, ...draft, lodgingTaxNote: note || null } }),
    onSuccess: () => {
      toast.success("Saved to your own records");
      reset();
      refresh();
    },
    onError: fail,
  });
  const removeM = useMutation({
    mutationFn: (id: string) => remove({ data: { propertyId, id } }),
    onSuccess: () => {
      toast.success("Removed");
      refresh();
    },
    onError: fail,
  });

  return (
    <OwnerPageShell>
      <Link to="/owner/properties/$propertyId" params={{ propertyId }} className="text-sm text-muted-foreground hover:text-foreground">
        ← Owner dashboard
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Short-term rental records</h1>
      <p className="mt-2 max-w-3xl rounded-xl border border-border bg-card p-4 text-sm text-foreground">{OWNER_STR_NOTICE}</p>
      <div className="mt-6 space-y-4">
        {isLoading || authLoading ? <OwnerLoading /> : null}
        {isError ? (
          <p className="text-sm text-destructive">
            Couldn't load your records.{" "}
            <button type="button" className="underline" onClick={() => refetch()}>
              Try again
            </button>
          </p>
        ) : null}
        {data?.allowed && !data.trackerEnabled ? <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">This home isn't set up for short-term rental, so there's nothing to record here.</p> : null}
        {data?.allowed && data.trackerEnabled ? (
          <>
            <p className="text-sm text-muted-foreground">Only you can see these records. They are never posted to the LLC's books and never appear in any LLC report.</p>
            <form
              className="space-y-3 rounded-xl border border-border bg-card p-4"
              onSubmit={(e) => {
                e.preventDefault();
                saveM.mutate();
              }}
            >
              <h2 className="text-sm font-semibold text-foreground">{editing ? "Edit a record" : "Add a record for your own weeks"}</h2>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-xs font-medium text-foreground">
                  Period start
                  <input type="date" className={FIELD} value={start} onChange={(e) => setStart(e.target.value)} />
                </label>
                <label className="text-xs font-medium text-foreground">
                  Period end
                  <input type="date" className={FIELD} value={end} onChange={(e) => setEnd(e.target.value)} />
                </label>
                <label className="text-xs font-medium text-foreground">
                  Nights rented
                  <input className={FIELD} inputMode="numeric" value={nights} onChange={(e) => setNights(e.target.value)} />
                </label>
                <label className="text-xs font-medium text-foreground">
                  Gross income ($)
                  <input className={FIELD} inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} />
                </label>
                <label className="text-xs font-medium text-foreground">
                  Platform fees ($)
                  <input className={FIELD} inputMode="decimal" value={fees} onChange={(e) => setFees(e.target.value)} />
                </label>
                <label className="text-xs font-medium text-foreground">
                  Lodging tax
                  <select className={FIELD} value={status} onChange={(e) => setStatus(e.target.value as LodgingTaxStatus)}>
                    {LODGING_TAX_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {LODGING_TAX_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block text-xs font-medium text-foreground">
                Note about lodging tax (optional)
                <input className={FIELD} value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              {start && end && nights && problem ? <p className="text-xs text-destructive">{problem}</p> : null}
              <div className="flex gap-2">
                <button type="submit" className={PRIMARY} disabled={!!problem || !start || !end || saveM.isPending}>
                  {editing ? "Save changes" : "Add record"}
                </button>
                {editing ? (
                  <button type="button" className={SECONDARY} onClick={reset}>
                    Cancel
                  </button>
                ) : null}
              </div>
            </form>
            {data.records.length === 0 ? <p className="text-sm text-muted-foreground">You haven't recorded anything yet.</p> : null}
            {data.records.map((r) => (
              <section key={r.id} className="rounded-xl border border-border bg-card p-4 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <div className="font-medium text-foreground">
                    {r.periodStart} to {r.periodEnd} · {r.nights} nights
                  </div>
                  <div className="text-foreground">{formatCents(r.grossCents)} gross</div>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Platform fees {formatCents(r.feesCents)} · Lodging tax: {LODGING_TAX_LABELS[r.lodgingTaxStatus]}
                  {r.lodgingTaxNote ? ` · ${r.lodgingTaxNote}` : ""}
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className={SECONDARY}
                    onClick={() => {
                      setEditing(r.id);
                      setStart(r.periodStart);
                      setEnd(r.periodEnd);
                      setNights(String(r.nights));
                      setGross((r.grossCents / 100).toFixed(2));
                      setFees((r.feesCents / 100).toFixed(2));
                      setStatus(r.lodgingTaxStatus);
                      setNote(r.lodgingTaxNote ?? "");
                    }}
                  >
                    Edit
                  </button>
                  <button type="button" className={SECONDARY} disabled={removeM.isPending} onClick={() => removeM.mutate(r.id)}>
                    Remove
                  </button>
                </div>
              </section>
            ))}
          </>
        ) : null}
      </div>
    </OwnerPageShell>
  );
}
