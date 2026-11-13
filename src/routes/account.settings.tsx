import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { getMyTermsStatus } from "@/lib/tc.functions";
import { diffPath } from "@/lib/tc";

/** Account settings, for every kind of user: the version of the Terms and Conditions you are bound by, and the history. */
export const Route = createFileRoute("/account/settings")({
  head: () => ({ meta: [{ title: "Account settings — divieight" }, { name: "robots", content: "noindex" }] }),
  component: AccountSettings,
});

function AccountSettings() {
  const { user, loading } = useAuth();
  const { data, isLoading, error } = useQuery({ queryKey: ["my-terms-status", user?.id], queryFn: () => getMyTermsStatus(), enabled: !!user, retry: false });

  if (!loading && !user) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-base text-muted-foreground">Sign in to see your account settings.</p>
        <Link to="/login" className="mt-4 inline-block rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">Account settings</h1>
      {user?.email ? <p className="mt-1 text-base text-muted-foreground">{user.email}</p> : null}

      <section className="mt-8 rounded-xl border border-border bg-card p-5" aria-labelledby="tc-heading">
        <h2 id="tc-heading" className="font-display text-xl font-semibold text-foreground">
          Terms and Conditions
        </h2>
        {isLoading || loading ? (
          <p className="mt-3 text-base text-muted-foreground">Loading…</p>
        ) : error || !data ? (
          <p className="mt-3 text-base text-destructive">Your Terms status could not be loaded. Try again in a moment.</p>
        ) : (
          <>
            {data.boundBy ? (
              <p className="mt-3 text-base text-foreground">
                You are bound by <strong>version {data.boundBy.version}</strong>, effective {data.boundBy.effectiveDate}.{" "}
                {data.boundBy.acceptedAt ? `Accepted by continued use on ${new Date(data.boundBy.acceptedAt).toLocaleDateString()}.` : "Your continued use records your acceptance."}{" "}
                <Link to="/terms" search={{ v: data.boundBy.version }} className="font-medium text-primary underline">
                  Read it
                </Link>
              </p>
            ) : null}
            {data.upcoming ? (
              <p role="status" className="mt-3 rounded-lg border border-border bg-muted/50 p-3 text-base text-foreground">
                Version {data.upcoming.version} takes effect on {data.upcoming.effectiveDate}. {data.upcoming.summary ? `${data.upcoming.summary} ` : ""}
                {data.boundBy ? (
                  <a href={diffPath(data.boundBy.version, data.upcoming.version)} className="font-medium text-primary underline">
                    See what changes
                  </a>
                ) : null}
                . If you keep using divieight after that date you accept it; you do not need to sign anything.
              </p>
            ) : null}

            <h3 className="mt-6 text-base font-semibold text-foreground">History</h3>
            <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
              {data.history.map((h) => {
                const accepted = data.acceptances.find((a) => a.version === h.version);
                return (
                  <li key={h.version} className="px-4 py-3 text-base">
                    <p className="font-medium text-foreground">
                      Version {h.version} <span className="font-normal text-muted-foreground">· effective {h.effectiveDate}{h.isMaterial ? " · material change" : ""}</span>
                    </p>
                    {h.summary ? <p className="text-sm text-muted-foreground">{h.summary}</p> : null}
                    <p className="mt-1 text-sm text-muted-foreground">
                      {accepted ? `You accepted it by continued use on ${new Date(accepted.acceptedAt).toLocaleDateString()}.` : "Not accepted by you (it was not in force while you used divieight)."}
                      {h.notifiedAt ? ` You were notified on ${new Date(h.notifiedAt).toLocaleDateString()}.` : ""}
                    </p>
                    <p className="mt-1 flex flex-wrap gap-4 text-sm">
                      <Link to="/terms" search={{ v: h.version }} className="font-medium text-primary underline">
                        Read
                      </Link>
                      {h.previousVersion ? (
                        <a href={diffPath(h.previousVersion, h.version)} className="font-medium text-primary underline">
                          What changed
                        </a>
                      ) : null}
                    </p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
