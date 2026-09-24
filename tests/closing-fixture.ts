/** Shared closing-ready pod used by the settlement and closing-saga tests. */
import { harness } from "./setup";
import { seedPod, IDS, USERS, hoursFromNow } from "./fixtures";
import { ensureDigitalGenesis } from "@/lib/entity-genesis.server";

const db = () => harness.db;
export const PER_SHARE = 781_250; // 2.5% of a $312,500 share, in cents

/** Closing-ready pod: 5 retained + B1 (1 share) + B2 (2 shares); B2 came via a NAR referral from RA2; HLA at a second brokerage. */
export async function seedClosing() {
  seedPod(db());
  Object.assign(db().table("properties")[0], {
    exit_type: "hybrid_exit",
    retained_shares: 5,
    anticipated_closing_date: "2026-10-15",
    listing_agent_id: null,
  });
  db().table("agents").find((a) => a.id === IDS.hla)!.broker_id = "broker-2";
  db().seed("brokers", [{ id: "broker-2", auth_user_id: "u-broker2", brokerage_name: "Summit Realty", license_number: "BR-2", tax_form_verified: true }]);
  Object.assign(db().table("brokers").find((b) => b.id === IDS.broker)!, { brokerage_name: "Lusk Homes", license_number: "BR-1", tax_form_verified: true });

  await ensureDigitalGenesis(db(), { propertyId: IDS.property, actorId: USERS.admin, reason: "hard_lock" });
  Object.assign(db().table("entity_genesis")[0], {
    cap_table_locked_at: new Date().toISOString(),
    llc_name: "D8 Independence Lusk, LLC",
    ein: "12-3456789",
    ein_status: "verified",
    tin_match_result: "match",
  });
  db().seed("insurance_policies", [
    { property_id: IDS.property, status: "bound", effective_date: "2026-10-01", renews_at: "2027-10-01", carrier_name: "Chubb", policy_number: "HO-1" },
  ]);
  db().seed("title_escrow_orders", [{ property_id: IDS.property, provider: "qualia", external_order_id: "SIM-QUALIA-ORDER1", bundle_payload: {} }]);
  db().seed("pending_referral_agreements", [
    { buyer_account_id: IDS.b2, non_resident_agent_id: IDS.ra2, resident_agent_id: IDS.ra, referring_agent_role: "non_resident", status: "executed" },
  ]);
  for (const [buyer, id] of [
    [IDS.b1, "req-b1"],
    [IDS.b2, "req-b2"],
  ] as const) {
    db().seed("authorization_requests", [
      { id, property_id: IDS.property, buyer_account_id: buyer, action_type: "final_repa_acceptance", status: "authorized", headline: "REPA", deadline_at: hoursFromNow(1), consequence_text: "x" },
    ]);
    db().seed("authorization_commission_items", [{ request_id: id, status: "authorized", per_share_amount_cents: PER_SHARE, rate_percent: 2.5 }]);
  }
}

