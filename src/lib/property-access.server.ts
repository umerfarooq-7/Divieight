/**
 * Property scoping for buyer-facing records. A Buyer Account is connected to a
 * property only through its own reservation or cap-table entry for THAT
 * property — never through another property it holds. property-scope.sql
 * mirrors this rule in RLS (user_has_property_access).
 */

type Db = { from: (t: string) => any };

/**
 * True when the Buyer Account holds (or held) a share in the property.
 * `activeOnly` limits it to a live reservation — required for actions such as
 * acknowledging a document; history is enough to read past records.
 */
export async function buyerConnectedToProperty(
  db: Db,
  buyerAccountId: string,
  propertyId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<boolean> {
  if (!buyerAccountId || !propertyId) return false;
  let q = db
    .from("pod_reservations")
    .select("id")
    .eq("buyer_account_id", buyerAccountId)
    .eq("property_id", propertyId);
  if (opts.activeOnly) q = q.eq("status", "reserved");
  const { data: res } = await q.limit(1);
  if (((res ?? []) as unknown[]).length > 0) return true;
  if (opts.activeOnly) return false;
  const { data: cap } = await db
    .from("cap_table_entries")
    .select("id")
    .eq("buyer_account_id", buyerAccountId)
    .eq("property_id", propertyId)
    .limit(1);
  return ((cap ?? []) as unknown[]).length > 0;
}
