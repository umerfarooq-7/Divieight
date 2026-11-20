import { isCoBuyer } from "@/lib/account-members";

/**
 * Who on a Buyer Account is part of a given property. The account holder, and any second member the holder is acted for, always are. A co-buyer
 * (a limited sub-account with a login of their own) is part of a property only when the main buyer bought a share there with them
 * (reservation_co_members). That is the person the due-diligence gate, the authorizations, the cap table and the Operating Agreement ask for.
 */

type Db = { from: (t: string) => any };

/** The co-buyer members of this account who are on a share on this property. */
export async function coBuyerIdsOnProperty(db: Db, accountId: string, propertyId: string): Promise<Set<string>> {
  const { data } = await db.from("reservation_co_members").select("account_member_id").eq("buyer_account_id", accountId).eq("property_id", propertyId);
  return new Set(((data ?? []) as Array<{ account_member_id: string }>).map((r) => r.account_member_id));
}

/** Active members of the account that belong to this property, in a stable order. With no property, everyone except the co-buyers. */
export async function membersForProperty<T extends Record<string, any> = Record<string, any>>(db: Db, accountId: string, propertyId: string | null | undefined): Promise<T[]> {
  const { data } = await db.from("account_members").select("*").eq("buyer_account_id", accountId).eq("status", "active");
  const rows = (data ?? []) as Array<T & { id: string; role: string; auth_user_id?: string | null; invite_token_hash?: string | null }>;
  const on = propertyId ? await coBuyerIdsOnProperty(db, accountId, propertyId) : new Set<string>();
  return rows.filter((m) => !isCoBuyer(m) || on.has(m.id));
}

/**
 * The buyer account a login belongs to: the holder's own, or the account a co-buyer is a limited member of.
 * Server-side lookups that used to read buyer_accounts by auth_user_id go through this, so a co-buyer reaches the shares they are on.
 */
export async function buyerAccountByLogin<T = Record<string, any>>(db: Db, userId: string, cols: string): Promise<T | null> {
  const { data } = await db.from("buyer_accounts").select(cols).eq("auth_user_id", userId).maybeSingle();
  if (data) return data as T;
  const { data: member } = await db.from("account_members").select("buyer_account_id").eq("auth_user_id", userId).eq("status", "active").maybeSingle();
  const accountId = (member as { buyer_account_id?: string } | null)?.buyer_account_id;
  if (!accountId) return null;
  const { data: acct } = await db.from("buyer_accounts").select(cols).eq("id", accountId).maybeSingle();
  return (acct as T | null) ?? null;
}
