import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { useAuth } from "@/hooks/use-auth";
import { formatDate } from "@/lib/format-date";
import { getFormerSellerWeeks } from "@/lib/resale.functions";

export const Route = createFileRoute("/owner/former/$propertyId")({
  head: () => ({
    meta: [
      { title: "Your Use Calendar weeks — divieight" },
      { name: "description", content: "The Use Calendar weeks you picked before you sold your shares." },
      { property: "og:title", content: "Your Use Calendar weeks — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: FormerSellerPage,
});

/**
 * For someone who sold every share in this property: only the Use Calendar weeks they already picked, read-only.
 * Nothing else of the owner area opens for them.
 */
function FormerSellerPage() {
  const { propertyId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getFormerSellerWeeks);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["former-seller-weeks", propertyId, user?.id],
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
    toast.error("There's nothing to show here.");
    navigate({ to: "/owner" });
  }, [denied, navigate]);

  const weeks = data?.weeks ?? [];
  const upcoming = weeks.filter((w) => w.upcoming);
  const past = weeks.filter((w) => !w.upcoming);
  return (
    <OwnerPageShell>
      <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">Your Use Calendar weeks</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        You sold your shares{data?.propertyLabel ? ` in ${data.propertyLabel}` : ""}. These are the weeks you picked before the sale, and they stay yours. This page is read-only.
      </p>
      <div className="mt-6 space-y-6">
        {isError ? (
          <p className="text-sm text-muted-foreground">We couldn't load your weeks.</p>
        ) : authLoading || isLoading || !data || denied ? (
          <OwnerLoading />
        ) : weeks.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">You have no picked weeks on this property.</p>
        ) : (
          <>
            <WeekList title="Upcoming" weeks={upcoming} />
            <WeekList title="Past" weeks={past} />
          </>
        )}
      </div>
      <p className="mt-8 text-xs text-muted-foreground">
        <Link to="/owner" className="hover:text-foreground">
          Back
        </Link>
      </p>
    </OwnerPageShell>
  );
}

function WeekList({ title, weeks }: { title: string; weeks: Array<{ year: number; weekNumber: number; startDate: string; endDate: string; isHoliday: boolean }> }) {
  if (weeks.length === 0) return null;
  return (
    <section>
      <h2 className="font-display text-lg font-semibold text-foreground">{title}</h2>
      <ul className="mt-3 space-y-2">
        {weeks.map((w) => (
          <li key={`${w.year}-${w.weekNumber}`} className="rounded-xl border border-border bg-card p-4 text-sm text-foreground">
            Week {w.weekNumber}, {w.year}: {formatDate(w.startDate)} to {formatDate(w.endDate)}
            {w.isHoliday ? <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Holiday week</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
