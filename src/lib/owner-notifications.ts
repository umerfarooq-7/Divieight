/** Owner notification types, which can't be switched off, and grouping for the bell. */

export const OWNER_NOTIFICATION_TYPES = {
  distribution_event: { label: "Distributions", mandatory: false },
  capital_call_alert: { label: "Capital calls", mandatory: true },
  governance_vote_window: { label: "Voting windows", mandatory: true },
  resale_activity: { label: "Resale activity", mandatory: false },
  /** Expenses posted, voided, and their payments confirmed. Optional: the email can be switched off, the bell is always on. */
  expense_posted: { label: "Expenses", mandatory: false },
  maintenance_update: { label: "Maintenance updates", mandatory: false },
  calendar_turn: { label: "Use Calendar turns", mandatory: false },
  retention_exception_update: { label: "Retention Lock requests", mandatory: false },
  notice_posted: { label: "Governance notices", mandatory: true },
  /** The Manager's answer to a question or suggestion about a transaction. Optional: the email can be switched off, the bell is always on. */
  inquiry_update: { label: "Answers about the books", mandatory: false },
} as const;

export type OwnerNotificationType = keyof typeof OWNER_NOTIFICATION_TYPES;

/** Where tapping a notification goes, when it goes anywhere. */
export const notificationHref = (n: { type: string; property_id?: string | null }): string | null =>
  n.type === "former_seller_weeks" && n.property_id ? `/owner/former/${n.property_id}` : null;

export const isOwnerNotificationType = (type: string): type is OwnerNotificationType => type in OWNER_NOTIFICATION_TYPES;

/** Rev 48 floor: governance, capital call and voting window emails always go. */
export const isMandatoryNotification = (type: string) => isOwnerNotificationType(type) && OWNER_NOTIFICATION_TYPES[type].mandatory;

export interface GroupableNotification {
  property_id?: string | null;
}

/** Keeps newest-first order inside each group. Nothing tied to a property goes first, unlabelled. */
export function groupByProperty<T extends GroupableNotification>(items: T[], labels: Record<string, string>): Array<{ key: string; label: string | null; items: T[] }> {
  const groups = new Map<string, { key: string; label: string | null; items: T[] }>();
  for (const item of items) {
    const key = item.property_id ?? "";
    const group = groups.get(key) ?? { key, label: key ? (labels[key] ?? "A property") : null, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Number(Boolean(a.key)) - Number(Boolean(b.key)));
}
