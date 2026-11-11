/**
 * What a tethered agent may see of a buyer's vetting.
 *
 * Rev 49 counsel items D2(a)/D2(b): the Module 8 wording that tells the tethered agent about a vetting
 * outcome (the Binary Vetting Result sentence and the KYO Access Controls sentence) has been queued by the
 * client for counsel review. Current behaviour is kept EXACTLY. The agent sees only what they saw before.
 *
 * The 'held' eligibility status is shown to the agent as "Pending", and the reason is never shown: no
 * result, reason code, charge, declaration answer or KYO detail ever reaches an agent.
 */

/** The stage an agent is shown. A held account is shown as an ordinary pending stage, never as "held". */
export function agentVisibleStage(onboardingStatus: string, accountHeld: boolean, goldenTicketIssued: boolean): string {
  // Before the Golden Ticket, a held account reads exactly like any account still in vetting.
  if (accountHeld && !goldenTicketIssued) return "vetting_pending";
  // Nothing about 'held' can ride along in a status string.
  if (/held/i.test(onboardingStatus)) return "vetting_pending";
  return onboardingStatus;
}
