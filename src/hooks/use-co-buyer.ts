import { useQuery } from "@tanstack/react-query";
import { getCoBuyerSelf } from "@/lib/co-buyer-members.functions";

/** True when the signed-in login is a co-buyer's (a limited member of someone else's account). Shared cache with the dashboard's check. */
export function useIsCoBuyer(): boolean {
  const q = useQuery({ queryKey: ["co-buyer-self-check"], queryFn: () => getCoBuyerSelf(), retry: false, staleTime: 60_000 });
  return Boolean(q.data);
}
