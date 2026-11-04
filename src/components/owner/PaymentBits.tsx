import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { expenseMoney, paymentLabel, type PaymentKind } from "@/lib/expenses";
import { getOwnerPaymentNotice, markPaymentPaid } from "@/lib/expenses.functions";
import type { MyAllocation } from "@/lib/expenses.server";

/** Overdue is a notice only: it sits above the dashboard and hides nothing. */
export function OverduePaymentNotice({ propertyId }: { propertyId: string }) {
  const { user } = useAuth();
  const load = useServerFn(getOwnerPaymentNotice);
  const { data } = useQuery({
    queryKey: ["owner-payment-notice", propertyId, user?.id],
    enabled: !!user,
    retry: false,
    queryFn: () => load({ data: { propertyId } }),
  });
  if (!data?.overdueCount) return null;
  return (
    <p role="status" className="mb-4 rounded-lg border border-border bg-secondary/40 p-3 text-sm text-foreground">
      You have {expenseMoney(data.overdueAmount)} overdue on {data.overdueCount === 1 ? "a capital call" : `${data.overdueCount} capital calls`}. This is a notice only: your vote,
      calendar and other owner rights are not affected.{" "}
      <Link to="/owner/properties/$propertyId/capital-calls" params={{ propertyId }} className="font-medium text-primary hover:underline">
        View capital calls
      </Link>
    </p>
  );
}

/** One holder's own allocation, with the "I've paid" button. */
export function MyAllocationLine({ kind, allocation, invalidate }: { kind: PaymentKind; allocation: MyAllocation; invalidate: string[][] }) {
  const qc = useQueryClient();
  const mark = useServerFn(markPaymentPaid);
  const mut = useMutation({
    mutationFn: () => mark({ data: { kind, allocationId: allocation.id } }),
    onSuccess: (r) => {
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success("Marked as paid. divieight will confirm it once received.");
      for (const queryKey of invalidate) void qc.invalidateQueries({ queryKey });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm">
      <p className="text-foreground">
        Your share: <span className="font-semibold">{expenseMoney(allocation.amount)}</span>{" "}
        <span className="text-muted-foreground">
          ({allocation.shareCount} {allocation.shareCount === 1 ? "share" : "shares"}) · {paymentLabel(kind, allocation.status, allocation.paidMarkedAt)}
        </span>
      </p>
      {allocation.canMarkPaid ? (
        <button
          type="button"
          disabled={mut.isPending}
          onClick={() => mut.mutate()}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary disabled:opacity-50"
        >
          {mut.isPending ? "Saving…" : "I've paid this"}
        </button>
      ) : null}
    </div>
  );
}
