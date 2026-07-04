import { ConsentStatus, prisma } from "@telephony/database";

/**
 * TCPA consent tracking for a lead. This is separate from the DNC list:
 * DNC ("do not call this number at all") is opt-out and number-scoped,
 * consent ("this lead agreed to be contacted") is opt-in and lead-scoped -
 * a lead can lack consent without ever having asked to be put on the DNC list.
 */
export async function recordConsent(leadId: string, source?: string) {
  return prisma.lead.update({
    where: { id: leadId },
    data: { consentStatus: ConsentStatus.GRANTED, consentSource: source, consentedAt: new Date() },
  });
}

export async function revokeConsent(leadId: string) {
  return prisma.lead.update({
    where: { id: leadId },
    data: { consentStatus: ConsentStatus.REVOKED, consentedAt: new Date() },
  });
}

export async function hasConsent(leadId: string): Promise<boolean> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { consentStatus: true } });
  return lead?.consentStatus === ConsentStatus.GRANTED;
}
