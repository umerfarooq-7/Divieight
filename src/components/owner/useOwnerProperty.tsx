import { useEffect, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { getOwnerProperty } from "@/lib/owner.functions";

/** Loads one owned property; anyone else is sent to /owner with a message. */
export function useOwnerProperty(propertyId: string) {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const load = useServerFn(getOwnerProperty);
  const query = useQuery({
    queryKey: ["owner-property", propertyId, user?.id],
    enabled: !!user,
    retry: false,
    queryFn: () => load({ data: { propertyId } }),
  });

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/buyer/login" });
  }, [authLoading, user, navigate]);

  const denied = query.data?.access === "none";
  useEffect(() => {
    if (!denied) return;
    toast.error("You don't have ownership in that property.");
    navigate({ to: "/owner" });
  }, [denied, navigate]);

  return query;
}

export function OwnerPageShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">{children}</div>;
}

export function OwnerLoading() {
  return <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>;
}

/** Shown to a shareholder until closing has completed. */
export function OwnershipPendingNotice({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center shadow-sm">
      <KeyRound className="mx-auto h-6 w-6 text-accent" aria-hidden />
      <h1 className="mt-3 font-display text-xl font-semibold text-foreground">Your ownership activates after closing</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {label}. Your owner dashboard opens once the Operating Agreement is executed and your Digital Key is issued at
        closing.
      </p>
      <Link to="/owner" className="mt-5 inline-block text-sm font-medium text-primary hover:underline">
        Back to my properties
      </Link>
    </div>
  );
}
