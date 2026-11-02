import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDate } from "@/lib/format-date";
import {
  createCalendarYearAsAdmin,
  getAdminCalendar,
  lockCalendarYear,
  openCalendarSelection,
  overrideCalendarWeek,
  setCalendarHolidays,
  setCalendarTurnHours,
} from "@/lib/use-calendar.functions";
import { DEFAULT_TURN_HOURS } from "@/lib/use-calendar";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/properties/$id/calendar")({
  head: () => ({
    meta: [
      { title: "Use Calendar — divieight admin" },
      { name: "description", content: "Create calendar years, flag holidays, run selection and lock the year." },
      { property: "og:title", content: "Use Calendar — divieight admin" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminCalendar,
});

const FIELD = "rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
type CalendarData = Awaited<ReturnType<typeof getAdminCalendar>>;
type YearData = CalendarData["years"][number];

function AdminCalendar() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const load = useServerFn(getAdminCalendar);
  const create = useServerFn(createCalendarYearAsAdmin);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-calendar", id],
    retry: false,
    queryFn: () => load({ data: { propertyId: id } }),
  });
  const [year, setYear] = useState(String(new Date().getFullYear() + 1));
  const [hours, setHours] = useState(String(DEFAULT_TURN_HOURS));
  const createMut = useMutation({
    mutationFn: () => create({ data: { propertyId: id, year: Number(year), turnHours: Number(hours) } }),
    onSuccess: () => {
      toast.success("Year created as a draft.");
      void qc.invalidateQueries({ queryKey: ["admin-calendar", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <Link to="/admin/properties" className="text-sm text-muted-foreground hover:text-foreground">
        ← Properties
      </Link>
      <h1 className="mt-3 font-display text-2xl font-semibold text-foreground">Use Calendar</h1>
      {data ? <p className="mt-1 text-sm text-muted-foreground">{data.label}</p> : null}
      <p className="mt-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        Quotas and pick order are PLACEHOLDERS pending Operating Agreement language.
      </p>

      {isLoading ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="mt-6 text-sm text-destructive">{error.message}</p>
      ) : data ? (
        <>
          <section className="mt-5 rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">Pick order</h2>
            {data.holders.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No holders on the cap table yet.</p>
            ) : (
              <ol className="mt-2 space-y-1 text-sm">
                {data.holders.map((h) => (
                  <li key={h.holderKey} className="text-foreground">
                    {h.rank}. {h.name} ({h.shares} share{h.shares === 1 ? "" : "s"})
                    {h.note ? <span className="ml-2 text-xs font-medium text-destructive">{h.note}</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
            <label className="text-xs text-muted-foreground">
              Year
              <input type="number" value={year} onChange={(e) => setYear(e.target.value)} className={`${FIELD} mt-1 block w-28`} />
            </label>
            <label className="text-xs text-muted-foreground">
              Hours per turn
              <input type="number" value={hours} onChange={(e) => setHours(e.target.value)} className={`${FIELD} mt-1 block w-28`} />
            </label>
            <button
              type="button"
              disabled={createMut.isPending}
              onClick={() => createMut.mutate()}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Create year
            </button>
          </section>

          <div className="mt-4 space-y-4">
            {data.years.map((y) => (
              <YearCard key={y.id} propertyId={id} year={y} holders={data.holders} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function YearCard({ propertyId, year, holders }: { propertyId: string; year: YearData; holders: CalendarData["holders"] }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin-calendar", propertyId] });
  const setHolidays = useServerFn(setCalendarHolidays);
  const setHoursFn = useServerFn(setCalendarTurnHours);
  const open = useServerFn(openCalendarSelection);
  const lock = useServerFn(lockCalendarYear);
  const override = useServerFn(overrideCalendarWeek);

  const [holidayText, setHolidayText] = useState(year.holidayWeeks.join(", "));
  const [hours, setHours] = useState(String(year.turnHours));
  const [week, setWeek] = useState("1");
  const [holderKey, setHolderKey] = useState("");
  const [reason, setReason] = useState("");

  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      toast.success("Saved.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-foreground">{year.year}</h2>
        <span className="rounded-full bg-muted px-3 py-1 text-xs text-foreground">{year.status.replace("_", " ")}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Rotation offset {year.rotationOffset}
        {year.turnHolderName
          ? ` · Turn: ${year.turnHolderName} (${year.turnPhase}, round ${year.turnRound})${year.deadlineAt ? ` · until ${new Date(year.deadlineAt).toLocaleString()}` : ""}`
          : ""}
      </p>

      {year.status !== "draft" ? (
        <ul className="mt-2 space-y-0.5 text-xs text-foreground">
          {holders.map((h) => (
            <li key={h.holderKey}>
              {h.name}: {year.picks[h.holderKey] ?? 0} of {year.quotas[h.holderKey] ?? 0} weeks
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        {year.status === "draft" ? (
          <>
            <label className="min-w-0 flex-1 text-xs text-muted-foreground">
              Holiday weeks (numbers, comma separated)
              <input value={holidayText} onChange={(e) => setHolidayText(e.target.value)} className={`${FIELD} mt-1 block w-full`} />
            </label>
            <button
              type="button"
              disabled={act.isPending}
              onClick={() =>
                act.mutate(() =>
                  setHolidays({ data: { yearId: year.id, holidayWeeks: holidayText.split(",").map((w) => w.trim()).filter(Boolean).map(Number) } }),
                )
              }
              className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
            >
              Save holidays
            </button>
          </>
        ) : null}
        {year.status !== "locked" ? (
          <>
            <label className="text-xs text-muted-foreground">
              Hours per turn
              <input type="number" value={hours} onChange={(e) => setHours(e.target.value)} className={`${FIELD} mt-1 block w-24`} />
            </label>
            <button
              type="button"
              disabled={act.isPending}
              onClick={() => act.mutate(() => setHoursFn({ data: { yearId: year.id, hours: Number(hours) } }))}
              className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
            >
              Save hours
            </button>
          </>
        ) : null}
        {year.status === "draft" ? (
          <button
            type="button"
            disabled={act.isPending}
            onClick={() => act.mutate(() => open({ data: { yearId: year.id } }))}
            className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Open selection
          </button>
        ) : null}
        {year.status === "selection_open" ? (
          <button
            type="button"
            disabled={act.isPending}
            onClick={() => act.mutate(() => lock({ data: { yearId: year.id } }))}
            className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Lock year
          </button>
        ) : null}
      </div>

      {year.status !== "draft" ? (
        <div className="mt-4 rounded-lg border border-border p-3">
          <p className="text-xs font-semibold text-foreground">Force-assign or clear a week (logged)</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <select value={week} onChange={(e) => setWeek(e.target.value)} aria-label="Week" className={FIELD}>
              {year.weeks.map((w) => (
                <option key={w.weekNumber} value={w.weekNumber}>
                  Week {w.weekNumber} ({formatDate(w.startDate)}): {w.holderName ?? "open"}
                </option>
              ))}
            </select>
            <select value={holderKey} onChange={(e) => setHolderKey(e.target.value)} aria-label="Holder" className={FIELD}>
              <option value="">Clear (make open)</option>
              {holders.map((h) => (
                <option key={h.holderKey} value={h.holderKey}>
                  {h.name}
                </option>
              ))}
            </select>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" aria-label="Reason" className={`${FIELD} min-w-0 flex-1`} />
            <button
              type="button"
              disabled={act.isPending || !reason.trim()}
              onClick={() => {
                act.mutate(() => override({ data: { yearId: year.id, weekNumber: Number(week), holderKey: holderKey || null, reason } }));
                setReason("");
              }}
              className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}

      <ol className="mt-3 grid grid-cols-4 gap-1 sm:grid-cols-8 lg:grid-cols-13">
        {year.weeks.map((w) => (
          <li
            key={w.weekNumber}
            title={`Week ${w.weekNumber}: ${w.holderName ?? "open"}`}
            className={cn(
              "truncate rounded border px-1 py-0.5 text-[10px]",
              w.holderKey ? "border-border bg-muted text-foreground" : "border-border text-muted-foreground",
              w.isHoliday && "border-2 border-accent",
            )}
          >
            {w.weekNumber}
            {w.holderName ? ` ${w.holderName}` : ""}
          </li>
        ))}
      </ol>
    </section>
  );
}
