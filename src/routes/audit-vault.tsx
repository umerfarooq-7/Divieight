import { createFileRoute } from "@tanstack/react-router";
import { AuditVaultViewer } from "@/components/AuditVaultViewer";

/** The Audit Vault for the Manager, the Compliance Officer and external auditors: read-only, and every read is logged. Anyone else sees a 403. */
export const Route = createFileRoute("/audit-vault")({
  head: () => ({ meta: [{ title: "Audit Vault — divieight" }, { name: "robots", content: "noindex" }] }),
  component: AuditVaultViewer,
});
