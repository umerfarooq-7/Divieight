import { createFileRoute, Link } from "@tanstack/react-router";
import { Hourglass } from "lucide-react";
import { OWNER_SECTIONS } from "@/lib/owner-sections";
import {
  OwnerLoading,
  OwnerPageShell,
  OwnershipPendingNotice,
  useOwnerProperty,
} from "@/components/owner/useOwnerProperty";

/** Placeholder for owner sections built in later prompts. */
export const Route = createFileRoute("/owner/properties/$propertyId/$section")({
  head: () => ({
    meta: [
      { title: "Coming soon — divieight" },
      { name: "description", content: "This owner section is coming soon." },
      { property: "og:title", content: "Coming soon — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ComingSoon,
});

function ComingSoon() {
  const { propertyId, section } = Route.useParams();
  const { data, isLoading } = useOwnerProperty(propertyId);
  const label = OWNER_SECTIONS.find((s) => s.slug === section)?.label ?? "This section";

  return (
    <OwnerPageShell>
      {isLoading || !data || data.access === "none" ? (
        <OwnerLoading />
      ) : data.access === "inactive" ? (
        <OwnershipPendingNotice label={data.property.label} />
      ) : (
        <div className="rounded-xl border border-border bg-card p-8 text-center shadow-sm">
          <Hourglass className="mx-auto h-6 w-6 text-accent" aria-hidden />
          <h1 className="mt-3 font-display text-xl font-semibold text-foreground">{label} is coming soon</h1>
          <p className="mt-2 text-sm text-muted-foreground">We're still building this part of your owner dashboard.</p>
          <Link
            to="/owner/properties/$propertyId"
            params={{ propertyId }}
            className="mt-5 inline-block text-sm font-medium text-primary hover:underline"
          >
            Back to the owner dashboard
          </Link>
        </div>
      )}
    </OwnerPageShell>
  );
}
