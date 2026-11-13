import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { recordTermsContinuedUse } from "@/lib/tc.functions";

/**
 * Continued use is acceptance. Once per signed-in visit, the version of the Terms in force is recorded as accepted by this person (an implicit acceptance,
 * with the version). Nothing is shown and nobody is asked to re-sign. A failure here never gets in the person's way.
 */
export function TermsContinuedUse() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    const key = `divieight.terms-use.${user.id}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {
      /* without session storage it is simply recorded again; the record keeps one per version */
    }
    void recordTermsContinuedUse().catch(() => undefined);
  }, [user]);
  return null;
}
