import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { getStripe, getStripeEnvironment } from "@/lib/stripe";
import { createBuyerEnrollmentCheckout } from "@/utils/payments.functions";

export function BuyerEnrollmentCheckout({ returnUrl, actingMemberId }: { returnUrl: string; actingMemberId: string }) {
  const fetchClientSecret = async (): Promise<string> => {
    const result = await createBuyerEnrollmentCheckout({
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
