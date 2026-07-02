import { DncSource } from "@prisma/client";
import { prisma } from "../../config/prisma";

/**
 * Single source of truth for TCPA/DNC compliance. Every outbound-dialing
 * path (manual REST call, campaign dispatch, follow-up dispatch) must check
 * this before placing a call.
 */
export async function isNumberOnDnc(phoneNumber: string): Promise<boolean> {
  const entry = await prisma.dncEntry.findUnique({ where: { phoneNumber } });
  return entry !== null;
}

export async function addToDnc(phoneNumber: string, reason?: string, source: DncSource = DncSource.MANUAL) {
  return prisma.dncEntry.upsert({
    where: { phoneNumber },
    update: { reason: reason ?? undefined, source },
    create: { phoneNumber, reason, source },
  });
}

export async function removeFromDnc(phoneNumber: string): Promise<void> {
  await prisma.dncEntry.deleteMany({ where: { phoneNumber } });
}

export async function listDnc() {
  return prisma.dncEntry.findMany({ orderBy: { createdAt: "desc" } });
}
