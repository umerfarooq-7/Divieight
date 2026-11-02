/** Quick links on the owner dashboard; each shows Coming Soon until its prompt is built. */
export const OWNER_LLC_LINKS = [
  { tab: "operating-agreement", label: "Operating Agreement" },
  { tab: "co-owners", label: "Co-owners" },
  { tab: "governance", label: "Governance rules" },
  { tab: "notices", label: "Notices" },
] as const;

export const OWNER_SECTIONS = [
  { slug: "voting", label: "Voting" },
  { slug: "maintenance", label: "Maintenance" },
  { slug: "expenses", label: "Expenses" },
  { slug: "resale-shop", label: "Resale Shop" },
  { slug: "documents", label: "Documents" },
] as const;
