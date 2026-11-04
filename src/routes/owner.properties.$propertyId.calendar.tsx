import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { timeLeft } from "@/components/owner/VoteBits";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format-date";
import { getOwnerCalendar, selectCalendarWeek } from "@/lib/use-calendar.functions";
import type { OwnerCalendarWeek } from "@/lib/use-calendar.server";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/owner/properties/$propertyId/calendar")({
  head: () => ({
    meta: [
      { title: "Use Calendar — divieight" },
      { name: "description", content: "Your weeks at this home, and your turn to pick." },
      { property: "og:title", content: "Use Calendar — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { year?: number } => {
    const year = Number(search.year);
    return Number.isInteger(year) ? { year } : {};
  },
  component: OwnerCalendarPage,
});

const WEEK_STYLES: Record<OwnerCalendarWeek["state"], string> = {
  mine: "border-primary bg-primary text-primary-foreground",
  other: "border-border bg-muted text-muted-foreground",
  open: "border-border bg-card text-foreground",
};

function OwnerCalendarPage() {
  const { propertyId } = Route.useParams();
  const { year: requestedYear } = Route.useSearch();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const load = useServerFn(getOwnerCalendar);
  const pick = useServerFn(selectCalendarWeek);
  const queryKey = ["owner-calendar", propertyId, requestedYear ?? "current", user?.id];
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    enabled: !!user,
    retry: false,
    queryFn: () => load({ data: { propertyId, year: requestedYear ?? null } }),
  });
  const [chosen, setChosen] = useState<OwnerCalendarWeek | null>(null);

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/owner/login", search: { redirect: window.location.pathname } });
  }, [authLoading, user, navigate]);

  const denied = data?.allowed === false;
  useEffect(() => {
    if (!denied) return;
    toast.error("You don't have ownership in that property.");
    navigate({ to: "/owner" });
  }, [denied, navigate]);

  const year = data?.year ?? null;
  const mut = useMutation({
    mutationFn: (weekNumber: number) => pick({ data: { propertyId, year: year!.year, weekNumber } }),
    onSuccess: (r) => {
      setChosen(null);
      if (r.error) toast.error(r.error);
      else toast.success("Week picked.");
      void qc.invalidateQueries({ queryKey: ["owner-calendar", propertyId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <OwnerPageShell>
      <Link to="/owner/properties/$propertyId" params={{ propertyId }} className="text-sm text-muted-foreground hover:text-foreground">
        ← Owner dashboard
      </Link>
      <h1 className="mt-4 font-display text-2xl font-semibold text-foreground sm:text-3xl">Use Calendar</h1>

      <div className="mt-6">
        {isError ? (
          <p className="text-sm text-muted-foreground">
            We couldn't load the calendar.{" "}
            <button type="button" onClick={() => void refetch()} className="font-medium text-primary hover:underline">
              Try again
            </button>
          </p>
        ) : authLoading || isLoading || !data || denied ? (
          <OwnerLoading />
        ) : !year ? (
          <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            The calendar hasn't been published yet.
          </p>
        ) : (
          <>
            {data.years.length > 1 ? (
              <nav aria-label="Calendar year" className="mb-4 flex flex-wrap gap-2">
                {data.years.map((y) => (
                  <Link
                    key={y}
                    to="/owner/properties/$propertyId/calendar"
                    params={{ propertyId }}
                    search={{ year: y }}
                    className={cn(
                      "inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium",
                      y === year.year ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-secondary",
                    )}
                  >
                    {y}
                  </Link>
                ))}
              </nav>
            ) : null}

            {year.isMyTurn ? (
              <div className="rounded-xl border border-accent/50 bg-accent/10 p-4">
                <p className="flex items-center gap-2 font-display text-base font-semibold text-foreground">
                  <Sparkles className="h-4 w-4 text-accent" aria-hidden /> It's your turn
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pick one {year.phase === "holiday" ? "holiday " : ""}week.
                  {year.deadlineAt ? ` You have ${timeLeft(new Date(year.deadlineAt).getTime(), Date.now())}, then the turn moves on.` : ""}
                </p>
              </div>
            ) : (
              <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
                {year.status === "locked"
                  ? `The ${year.year} calendar is final.`
                  : year.turnHolderName
                    ? `Waiting for ${year.turnHolderName} to pick.`
                    : `Selection for ${year.year} is complete.`}
              </p>
            )}

            <p className="mt-3 text-sm text-foreground">
              {year.year}: you've picked {year.myPicked} of {year.myQuota} weeks.
            </p>
            <ul className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground" aria-label="Legend">
              <li className="flex items-center gap-1.5"><span className={cn("h-3 w-3 rounded border", WEEK_STYLES.mine)} /> Mine</li>
              <li className="flex items-center gap-1.5"><span className={cn("h-3 w-3 rounded border", WEEK_STYLES.other)} /> Other owners</li>
              <li className="flex items-center gap-1.5"><span className={cn("h-3 w-3 rounded border", WEEK_STYLES.open)} /> Open</li>
              <li className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-2 border-accent" /> Holiday</li>
            </ul>

            <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {data.weeks.map((w) => (
                <li key={w.weekNumber}>
                  <button
                    type="button"
                    disabled={!w.selectable || mut.isPending}
                    onClick={() => setChosen(w)}
                    className={cn(
                      "h-full w-full rounded-lg border p-2 text-left text-xs",
                      WEEK_STYLES[w.state],
                      w.isHoliday && "border-2 border-accent",
                      w.selectable ? "cursor-pointer ring-offset-background hover:ring-2 hover:ring-accent" : "cursor-default",
                    )}
                  >
                    <span className="block font-semibold">
                      Week {w.weekNumber}
                      {w.isHoliday ? " · Holiday" : ""}
                    </span>
                    <span className="block">
                      {formatDate(w.startDate)}
                    </span>
                    <span className="mt-1 block truncate">{w.holderName ?? "Open"}</span>
                  </button>
                </li>
              ))}
            </ol>

            {chosen ? (
              <div role="dialog" aria-label="Confirm week" className="sticky bottom-4 mt-4 rounded-xl border border-border bg-card p-4 shadow-lg">
                <p className="text-sm text-foreground">
                  Pick week {chosen.weekNumber} ({formatDate(chosen.startDate)} to {formatDate(chosen.endDate)})?
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={mut.isPending}
                    onClick={() => mut.mutate(chosen.weekNumber)}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  >
                    {mut.isPending ? "Saving…" : "Confirm"}
                  </button>
                  <button type="button" onClick={() => setChosen(null)} className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground">
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </OwnerPageShell>
  );
}
