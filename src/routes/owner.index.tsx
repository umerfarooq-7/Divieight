import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { listOwnerProperties } from "@/lib/owner.functions";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";

export const Route = createFileRoute("/owner/")({
  head: () => ({
    meta: [
      { title: "My properties — divieight" },
      { name: "description", content: "The homes you co-own through divieight." },
      { property: "og:title", content: "My properties — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerHome,
});

function OwnerHome() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(listOwnerProperties);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["owner-properties", user?.id],
    enabled: !!user,
    retry: false,
    queryFn: () => load(),
  });

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/buyer/login" });
  }, [authLoading, user, navigate]);

  const properties = data?.properties ?? [];

  return (
    <OwnerPageShell>
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Owner</p>
      <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">My properties</h1>

      <div className="mt-6">
        {authLoading || isLoading ? (
          <OwnerLoading />
        ) : isError ? (
          <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
            We couldn't load your properties.{" "}
            <button type="button" onClick={() => void refetch()} className="font-medium text-primary hover:underline">
              Try again
            </button>
          </div>
        ) : properties.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            You don't hold shares in any property yet.
            <div className="mt-4">
              <Link to="/properties" className="font-medium text-primary hover:underline">
                Browse properties
              </Link>
            </div>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {properties.map((p) => (
              <li key={p.propertyId}>
                <Link
                  to="/owner/properties/$propertyId"
                  params={{ propertyId: p.propertyId }}
                  className="block h-full overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-colors hover:bg-secondary/60"
                >
                  {p.photo ? (
                    <img src={p.photo} alt="" className="h-40 w-full object-cover" />
                  ) : (
                    <div className="flex h-40 items-center justify-center bg-muted">
                      <Building2 className="h-8 w-8 text-muted-foreground" aria-hidden />
                    </div>
                  )}
                  <div className="p-4">
                    <h2 className="font-display text-base font-semibold text-foreground">{p.label}</h2>
                    {p.llcName ? <p className="mt-0.5 text-xs text-muted-foreground">{p.llcName}</p> : null}
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full bg-accent/15 px-3 py-1 font-medium text-accent">
                        {p.shareCount} of 8 shares
                      </span>
                      <span className="rounded-full border border-border px-3 py-1 text-muted-foreground">
                        {p.active ? "Active" : "Activates after closing"}
                      </span>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </OwnerPageShell>
  );
}
