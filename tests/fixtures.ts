import type { FakeDb } from "./fake-db";

/**
 * One live pod on a $2.5M home:
 *  - Buyer Account B1: two Account Members, 1 share
 *  - Buyer Account B2: one Account Member, 2 shares
 *  - Both tethered to Resident Agent RA; HLA is the pod's accepted Heavy Lifting Agent
 *  - Candidate B3 is liquidity-verified and available for substitution
 */
export const IDS = {
  property: "prop-1",
  seller: "seller-1",
  b1: "buyer-1",
  b2: "buyer-2",
  b3: "buyer-3",
  b1m1: "member-1a",
  b1m2: "member-1b",
  b2m1: "member-2a",
  b3m1: "member-3a",
  ra: "agent-ra",
  ra2: "agent-ra2",
  hla: "agent-hla",
  broker: "broker-1",
  res1: "res-1",
  res2: "res-2",
};

export const USERS = {
  admin: "u-admin",
  b1: "u-b1",
  b2: "u-b2",
  b3: "u-b3",
  ra: "u-ra",
  ra2: "u-ra2",
  hla: "u-hla",
  broker: "u-broker",
};

export function seedPod(db: FakeDb) {
  db.rpcResults.has_role = (a: { _user_id: string; _role: string }) =>
    a._role === "admin" && a._user_id === USERS.admin;
  db.seed("user_roles", [{ user_id: USERS.admin, role: "admin" }]);

  db.seed("properties", [
    {
      id: IDS.property,
      address: "5632 Independence Ave",
      city: "Lusk",
      state: "WY",
      zip: "82225",
      seller_id: IDS.seller,
      listing_price: 2_500_000,
      exit_type: "full_exit",
      retained_shares: 0,
      listing_status: "forming",
      hard_locked: true,
      hard_locked_at: "2026-09-01T00:00:00.000Z",
    },
  ]);

  db.seed("buyer_accounts", [
    { id: IDS.b1, auth_user_id: USERS.b1, email: "b1@test.local", tethered_resident_agent_id: IDS.ra, liquidity_verified: true },
    { id: IDS.b2, auth_user_id: USERS.b2, email: "b2@test.local", tethered_resident_agent_id: IDS.ra, liquidity_verified: true },
    { id: IDS.b3, auth_user_id: USERS.b3, email: "b3@test.local", tethered_resident_agent_id: IDS.ra, liquidity_verified: true },
  ]);
  db.seed("account_members", [
    { id: IDS.b1m1, buyer_account_id: IDS.b1, full_name: "Alice One", role: "primary" },
    { id: IDS.b1m2, buyer_account_id: IDS.b1, full_name: "Bob One", role: "secondary" },
    { id: IDS.b2m1, buyer_account_id: IDS.b2, full_name: "Carol Two", role: "primary" },
    { id: IDS.b3m1, buyer_account_id: IDS.b3, full_name: "Dan Three", role: "primary" },
  ]);

  db.seed("agents", [
    { id: IDS.ra, auth_user_id: USERS.ra, full_name: "Rita Resident", email: "ra@test.local", broker_id: IDS.broker },
    { id: IDS.ra2, auth_user_id: USERS.ra2, full_name: "Rory Resident", email: "ra2@test.local", broker_id: IDS.broker },
    { id: IDS.hla, auth_user_id: USERS.hla, full_name: "Hank Heavy", email: "hla@test.local", broker_id: IDS.broker },
  ]);
  db.seed("brokers", [{ id: IDS.broker, auth_user_id: USERS.broker }]);

  db.seed("pods", [
    { property_id: IDS.property, heavy_lifting_agent_id: IDS.hla, hla_status: "accepted" },
  ]);

  db.seed("pod_reservations", [
    { id: IDS.res1, property_id: IDS.property, buyer_account_id: IDS.b1, shares_reserved: 1, status: "reserved", reserved_at: "2026-09-01T00:00:00.000+00:00" },
    { id: IDS.res2, property_id: IDS.property, buyer_account_id: IDS.b2, shares_reserved: 2, status: "reserved", reserved_at: "2026-09-02T00:00:00.000+00:00" },
  ]);
}

export function hoursFromNow(h: number) {
  return new Date(Date.now() + h * 3600_000).toISOString();
}
