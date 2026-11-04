import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { KeyRound, X } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { claimCoOwnerBanners, type CoOwnerBanner as Banner } from "@/lib/owner.functions";

/**
 * Tells a Hybrid Exit seller they've become a co-owner. The server hands each
 * property's banner out only once, so it stays in memory until closed here.
 */
export function CoOwnerBanner() {
  const { user } = useAuth();
  const claim = useServerFn(claimCoOwnerBanners);
  const [banners, setBanners] = useState<Banner[]>([]);
  const claimedFor = useRef<string | null>(null);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) {
      claimedFor.current = null;
      setBanners([]);
      return;
    }
    if (claimedFor.current === userId) return;
    claimedFor.current = userId;
    claim()
      .then((r) => setBanners(r.banners))
      .catch(() => undefined);
  }, [userId, claim]);

  if (banners.length === 0) return null;
  const close = (propertyId: string) => setBanners((all) => all.filter((b) => b.propertyId !== propertyId));

  return (
    <div className="border-b border-accent/40 bg-accent/10">
      {banners.map((b) => (
        <div key={b.propertyId} className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <KeyRound className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <p className="min-w-0 flex-1 text-sm font-medium text-foreground">
            You are now a co-owner of {b.llcName}. You hold {b.shareCount} share{b.shareCount === 1 ? "" : "s"}.
          </p>
          <Link
            to="/owner/properties/$propertyId"
            params={{ propertyId: b.propertyId }}
            onClick={() => close(b.propertyId)}
            className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Owner Dashboard
          </Link>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => close(b.propertyId)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
