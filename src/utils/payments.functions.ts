import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  type StripeEnv,
  createStripeClient,
  getStripeErrorMessage,
} from "@/lib/stripe.server";

const ENROLLMENT_PRICE_ID = "platform_enrollment_share";
const PER_SHARE_CENTS = 257000;

type CheckoutResult = { clientSecret: string } | { error: string };
type ConfirmResult = { paid: boolean } | { error: string };

/**
 * Creates (or reuses) the Stripe customer for this seller so purchases stay
 * linked to the user across sessions.
 */
async function resolveCustomer(
  stripe: ReturnType<typeof createStripeClient>,
  options: { userId: string; email?: string },
): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(options.userId)) throw new Error("Invalid userId");

  const found = await stripe.customers.search({
    query: `metadata['userId']:'${options.userId}'`,
    limit: 1,
  });
  if (found.data.length) return found.data[0].id;

  if (options.email) {
    const existing = await stripe.customers.list({ email: options.email, limit: 1 });
    if (existing.data.length) {
      const customer = existing.data[0];
      if (customer.metadata?.userId !== options.userId) {
        await stripe.customers.update(customer.id, {
          metadata: { ...customer.metadata, userId: options.userId },
        });
      }
      return customer.id;
    }
  }

  const created = await stripe.customers.create({
    ...(options.email && { email: options.email }),
    metadata: { userId: options.userId },
  });
  return created.id;
}

export const createEnrollmentCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { returnUrl: string; environment: StripeEnv }) => data)
  .handler(async ({ data, context }): Promise<CheckoutResult> => {
    const { supabase, userId } = context;

    const { data: seller } = await supabase
      .from("sellers")
      .select("email, exit_type, retained_shares")
      .eq("id", userId)
      .maybeSingle();

    const retained = seller?.retained_shares ?? 0;
    if (seller?.exit_type !== "hybrid_exit" || retained <= 1) {
      return { error: "No enrollment fee is due for this exit type." };
    }
    const quantity = retained - 1;

    try {
      const stripe = createStripeClient(data.environment);
      const prices = await stripe.prices.list({ lookup_keys: [ENROLLMENT_PRICE_ID] });
      if (!prices.data.length) return { error: "Enrollment fee price not found." };
      const price = prices.data[0];

      const customerId = await resolveCustomer(stripe, {
        userId,
        email: seller?.email ?? undefined,
      });

      const session = await stripe.checkout.sessions.create({
        line_items: [{ price: price.id, quantity }],
        mode: "payment",
        ui_mode: "embedded_page",
        return_url: data.returnUrl,
        customer: customerId,
        // Stripe Tax is not configured for this account yet (prices have no
        // tax_behavior), which made the embedded checkout fail to render.
        billing_address_collection: "required",
        payment_intent_data: { description: "Platform Enrollment Fee" },
        metadata: {
          userId,
          retainedShares: String(retained),
          kind: "enrollment_fee",
        },
      });

      await supabase.from("enrollment_payments").insert({
        seller_id: userId,
        retained_shares: retained,
        amount_cents: quantity * PER_SHARE_CENTS,
        status: "pending",
        stripe_session_id: session.id,
        environment: data.environment,
      });

      return { clientSecret: session.client_secret ?? "" };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

export const confirmEnrollmentPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string; environment: StripeEnv }) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(data.sessionId)) throw new Error("Invalid sessionId");
    return data;
  })
  .handler(async ({ data, context }): Promise<ConfirmResult> => {
    try {
      const stripe = createStripeClient(data.environment);
      const session = await stripe.checkout.sessions.retrieve(data.sessionId);

      if (session.metadata?.userId !== context.userId) {
        return { error: "This payment does not belong to your account." };
      }
      const paid = session.payment_status === "paid";
      if (!paid) return { paid: false };

      const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
      await supabaseAdmin
        .from("enrollment_payments")
        .update({ status: "paid" })
        .eq("stripe_session_id", session.id)
        .eq("seller_id", context.userId);

      return { paid: true };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

/* ------------------------------------------------------------------ *
 * Buyer Priority Reservation enrollment fee ($2,570, flat)            *
 * ------------------------------------------------------------------ */

const BUYER_ENROLLMENT_CENTS = 257000;

export const createBuyerEnrollmentCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { returnUrl: string; environment: StripeEnv; actingMemberId?: string }) => data)
  .handler(async ({ data, context }): Promise<CheckoutResult> => {
    const { supabase, userId } = context;

    // Pre-Payment Review: the member paying has read the PRA to the bottom and acknowledged it. Checked here, not only on the screen.
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");
      const { assertPrePaymentReview } = await import("@/lib/document-access.server");
      await assertPrePaymentReview(supabaseAdmin as never, { userId, actingMemberId: data.actingMemberId });
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Complete the Pre-Payment Review first." };
    }

    const { data: account } = await supabase
      .from("buyer_accounts")
      .select("id, email, priority_rank_timestamp")
      .eq("auth_user_id", userId)
      .maybeSingle();

    if (!account) return { error: "No buyer account found for this user." };
    if (account.priority_rank_timestamp) {
      return { error: "Your enrollment fee has already been paid." };
    }

    try {
      const stripe = createStripeClient(data.environment);
      const prices = await stripe.prices.list({ lookup_keys: [ENROLLMENT_PRICE_ID] });
      if (!prices.data.length) return { error: "Enrollment fee price not found." };
      const price = prices.data[0];

      const customerId = await resolveCustomer(stripe, {
        userId,
        email: account.email ?? undefined,
      });

      const session = await stripe.checkout.sessions.create({
        line_items: [{ price: price.id, quantity: 1 }],
        mode: "payment",
        ui_mode: "embedded_page",
        return_url: data.returnUrl,
        customer: customerId,
        billing_address_collection: "required",
        payment_intent_data: { description: "Buyer Platform Enrollment Fee" },
        metadata: {
          userId,
          buyerAccountId: account.id,
          kind: "buyer_enrollment_fee",
        },
      });

      await supabase.from("buyer_enrollment_payments").insert({
        buyer_account_id: account.id,
        auth_user_id: userId,
        amount_cents: BUYER_ENROLLMENT_CENTS,
        status: "pending",
        stripe_session_id: session.id,
        environment: data.environment,
      });

      return { clientSecret: session.client_secret ?? "" };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

type BuyerConfirmResult = { paid: boolean; priorityRankTimestamp?: string } | { error: string };

/**
 * Confirms the buyer enrollment payment server-side against Stripe.
 *
 * CRITICAL: `priority_rank_timestamp` (millisecond precision) determines buyer
 * seniority. It is stamped ONLY here, after Stripe reports payment_status
 * === "paid", and it is never overwritten once set.
 * TODO: swap to live keys + a Stripe webhook (checkout.session.completed) as
 * the authoritative confirmation path when going live.
 */
export const confirmBuyerEnrollmentPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string; environment: StripeEnv }) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(data.sessionId)) throw new Error("Invalid sessionId");
    return data;
  })
  .handler(async ({ data, context }): Promise<BuyerConfirmResult> => {
    try {
      const stripe = createStripeClient(data.environment);
      const session = await stripe.checkout.sessions.retrieve(data.sessionId);

      if (session.metadata?.userId !== context.userId) {
        return { error: "This payment does not belong to your account." };
      }
      if (session.payment_status !== "paid") return { paid: false };

      const { supabaseAdmin } = await import("@/integrations/supabase/admin.server");

      await supabaseAdmin
        .from("buyer_enrollment_payments")
        .update({ status: "paid" })
        .eq("stripe_session_id", session.id)
        .eq("auth_user_id", context.userId);

      const { data: account } = await supabaseAdmin
        .from("buyer_accounts")
        .select("id, priority_rank_timestamp")
        .eq("auth_user_id", context.userId)
        .maybeSingle();

      if (!account) return { error: "No buyer account found for this user." };

      let stamp = account.priority_rank_timestamp;
      if (!stamp) {
        stamp = new Date().toISOString(); // millisecond precision
        await supabaseAdmin
          .from("buyer_accounts")
          .update({ priority_rank_timestamp: stamp })
          .eq("id", account.id)
          .is("priority_rank_timestamp", null);
      }

      return { paid: true, priorityRankTimestamp: stamp ?? undefined };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });
