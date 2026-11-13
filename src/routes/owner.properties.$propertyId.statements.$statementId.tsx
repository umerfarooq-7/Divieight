import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { OwnerLoading, OwnerPageShell } from "@/components/owner/useOwnerProperty";
import { StatementView } from "@/components/StatementView";
import { useAuth } from "@/hooks/use-auth";
import { getStatement, getStatementPdf } from "@/lib/statements.functions";

export const Route = createFileRoute("/owner/properties/$propertyId/statements/$statementId")({
  head: () => ({
    meta: [
      { title: "Monthly statement — divieight" },
      { name: "description", content: "Your monthly statement for this home's LLC." },
      { property: "og:title", content: "Monthly statement — divieight" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OwnerStatementPage,
});

function OwnerStatementPage() {
  const { propertyId, statementId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const load = useServerFn(getStatement);
  const pdf = useServerFn(getStatementPdf);
  const { data, isLoading, isError, error } = useQuery({ queryKey: ["owner-statement", statementId, user?.id], enabled: !!user, retry: false, queryFn: () => load({ data: { statementId } }) });

  const download = async () => {
    try {
      const f = await pdf({ data: { statementId } });
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = f.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <OwnerPageShell>
      <Link to="/owner/properties/$propertyId/statements" params={{ propertyId }} className="text-sm text-muted-foreground hover:text-foreground">
        ← All statements
      </Link>
      <div className="mt-4 space-y-4">
        {isLoading || authLoading ? <OwnerLoading /> : null}
        {isError ? <p className="text-base text-destructive">{(error as Error).message}</p> : null}
        {data ? (
          <>
            {data.newerVersion ? (
              <p className="rounded-xl border border-border bg-muted p-4 text-base">
                This version was corrected.{" "}
                <Link to="/owner/properties/$propertyId/statements/$statementId" params={{ propertyId, statementId: data.newerVersion.id }} className="font-medium underline">
                  Read version {data.newerVersion.version}
                </Link>
                . It is kept here as it was issued.
              </p>
            ) : null}
            <button type="button" onClick={download} className="rounded-lg bg-primary px-4 py-2 text-base font-medium text-primary-foreground">
              Download the PDF
            </button>
            <StatementView snapshot={data.snapshot} holder={data.holder} version={data.version} status={data.status} issuedAt={data.issuedAt} />
          </>
        ) : null}
      </div>
    </OwnerPageShell>
  );
}
