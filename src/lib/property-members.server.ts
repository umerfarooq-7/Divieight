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

/**
 * Whose signature a login may give. A co-buyer signs only as themselves; the account holder's login signs for the holder and for any second member
 * who has no login of their own, never for a co-buyer. Checked on the server wherever a document is signed or acknowledged.
 */
export async function assertMayActAs(db: Db, userId: string, accountMemberId: string, accountId?: string): Promise<void> {
  const { data: m } = await db.from("account_members").select("id, buyer_account_id, auth_user_id").eq("id", accountMemberId).maybeSingle();
  const member = m as { buyer_account_id: string; auth_user_id?: string | null } | null;
  if (!member) throw new Error("Unknown Account Member");
  // A member of another account is the caller's own existing checks to refuse, with their own message.
  if (accountId && member.buyer_account_id !== accountId) return;
  if (member.auth_user_id) {
    if (member.auth_user_id !== userId) throw new Error("You can only sign for yourself.");
    return;
  }
  const { data: a } = await db.from("buyer_accounts").select("auth_user_id").eq("id", member.buyer_account_id).maybeSingle();
  if ((a as { auth_user_id?: string } | null)?.auth_user_id !== userId) throw new Error("You can only sign for yourself.");
}

/** The co-buyers on this property of the account this login holds: their own logins and addresses, so they are told what concerns their shares. */
export async function coBuyerRecipients(db: Db, holderAuthUserId: string | null | undefined, propertyId: string | null | undefined): Promise<Array<{ memberId: string; authUserId: string; email: string | null }>> {
  if (!holderAuthUserId || !propertyId) return [];
  const { data: acct } = await db.from("buyer_accounts").select("id").eq("auth_user_id", holderAuthUserId).maybeSingle();
  const accountId = (acct as { id: string } | null)?.id;
  if (!accountId) return [];
  const on = await coBuyerIdsOnProperty(db, accountId, propertyId);
  if (on.size === 0) return [];
  const { data } = await db.from("account_members").select("*").eq("buyer_account_id", accountId).eq("status", "active");
  return ((data ?? []) as Array<{ id: string; email: string | null; auth_user_id?: string | null }>)
    .filter((m) => on.has(m.id) && m.auth_user_id)
    .map((m) => ({ memberId: m.id, authUserId: m.auth_user_id as string, email: m.email }));
}

/**
 * Of these members, the ones this login may act as: a co-buyer only themselves; the account holder everyone without a login of their own.
 * Screens use it so nobody is offered a "responding as" choice for a person who signs from their own login.
 */
export async function actableMemberIds(db: Db, userId: string, accountId: string, memberIds: string[]): Promise<string[]> {
  const { data } = await db.from("account_members").select("id, auth_user_id").eq("buyer_account_id", accountId).eq("status", "active");
  const rows = (data ?? []) as Array<{ id: string; auth_user_id?: string | null }>;
  const mine = rows.find((m) => m.auth_user_id === userId);
  if (mine) return memberIds.filter((id) => id === mine.id);
  const withLogin = new Set(rows.filter((m) => m.auth_user_id).map((m) => m.id));
  return memberIds.filter((id) => !withLogin.has(id));
}
