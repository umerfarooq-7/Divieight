/** Quick links on the owner dashboard; each shows Coming Soon until its prompt is built. */
export const OWNER_LLC_LINKS = [
  { tab: "operating-agreement", label: "Operating Agreement" },
  { tab: "co-owners", label: "Co-owners" },
  { tab: "governance", label: "Governance rules" },
  { tab: "notices", label: "Notices" },
] as const;

/** Where to go after owner sign-in: only a page in the owner area, never another site. */
export function safeOwnerRedirect(path: string | null | undefined): string {
  if (!path || !/^\/owner(\/[\w-]+)*\/?$/.test(path) || /^\/owner\/login\/?$/.test(path)) return "/owner";
  return path;
}

export const OWNER_SECTIONS = [
  { slug: "maintenance", label: "Maintenance" },
  { slug: "expenses", label: "Expenses" },
  { slug: "documents", label: "Documents" },
] as const;
