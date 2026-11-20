import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { getStripe, getStripeEnvironment } from "@/lib/stripe";
import { createBuyerEnrollmentCheckout, createCoBuyerEnrollmentCheckout } from "@/utils/payments.functions";

/** The account's fee, or (coBuyer) a co-buyer's own fee. */
export function BuyerEnrollmentCheckout({ returnUrl, actingMemberId, coBuyer }: { returnUrl: string; actingMemberId: string; coBuyer?: boolean }) {
  const fetchClientSecret = async (): Promise<string> => {
    const result = coBuyer
      ? await createCoBuyerEnrollmentCheckout({ data: { returnUrl, environment: getStripeEnvironment() } })
      : await createBuyerEnrollmentCheckout({
          data: { returnUrl, environment: getStripeEnvironment(), actingMemberId },
        });
    if ("error" in result) throw new Error(result.error);
    if (!result.clientSecret) throw new Error("Checkout could not be started.");
    return result.clientSecret;
  };

  return (
    <div id="checkout" className="mt-6">
      <EmbeddedCheckoutProvider stripe={getStripe()} options={{ fetchClientSecret }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
