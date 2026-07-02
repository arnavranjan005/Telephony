import { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";
import { verifyTelnyxSignature } from "../lib/telnyx/webhookVerifier";
import { answerCall, decodeClientState, speakText, startTranscription } from "../lib/telnyx/callService";
import { handleCallerUtterance } from "../services/callConversationService";
import { placeOutboundCall } from "../services/outboundDialService";
import { callEventBus } from "../sse/eventBus";
import { CallStatus, CallDirection } from "@prisma/client";

const outboundCallSchema = z.object({
  toNumber: z.string().min(1),
  leadId: z.string().optional(),
});

export async function createOutboundCall(req: Request, res: Response) {
  const parsed = outboundCallSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { toNumber, leadId } = parsed.data;

  const result = await placeOutboundCall(toNumber, leadId);

  if (result.outcome === "skipped_dnc") {
    return res.status(403).json({ error: "This number is on the Do-Not-Call list" });
  }
  if (result.outcome === "failed") {
    return res.status(502).json({ error: result.error });
  }

  const call = await prisma.call.findUnique({ where: { id: result.callId } });
  res.status(201).json({ call });
}

export async function listCalls(_req: Request, res: Response) {
  const calls = await prisma.call.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  res.json({ calls });
}

export async function getCall(req: Request, res: Response) {
  const call = await prisma.call.findUnique({
    where: { id: req.params.callId },
    include: { messages: { orderBy: { createdAt: "asc" } }, appointments: true },
  });
  if (!call) return res.status(404).json({ error: "Call not found" });
  res.json({ call });
}

type TelnyxWebhookPayload = {
  data?: {
    event_type?: string;
    payload?: {
      call_control_id?: string;
      client_state?: string;
      from?: string;
      to?: string;
      transcription_data?: { transcript?: string; is_final?: boolean };
    };
  };
};

export async function handleTelnyxWebhook(req: Request, res: Response) {
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
  const signature = req.header("telnyx-signature-ed25519");
  const timestamp = req.header("telnyx-timestamp");

  if (!verifyTelnyxSignature(rawBody, signature, timestamp)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  // Acknowledge immediately; Telnyx expects a fast 200 response.
  res.status(200).send();

  const body = req.body as TelnyxWebhookPayload;
  const eventType = body.data?.event_type;
  const payload = body.data?.payload;
  if (!eventType || !payload?.call_control_id) return;

  const callControlId = payload.call_control_id;
  const clientState = decodeClientState(payload.client_state);
  const clientStateCallId = typeof clientState.callId === "string" ? clientState.callId : undefined;

  try {
    switch (eventType) {
      case "call.initiated": {
        // Inbound call: create a Call record if one doesn't already exist for this control id.
        const existing = await prisma.call.findUnique({ where: { telnyxCallControlId: callControlId } });
        if (!existing) {
          await prisma.call.create({
            data: {
              telnyxCallControlId: callControlId,
              direction: CallDirection.INBOUND,
              status: CallStatus.RINGING,
              fromNumber: payload.from ?? "unknown",
              toNumber: payload.to ?? "unknown",
            },
          });
        }
        if (clientStateCallId === undefined) {
          await answerCall(callControlId);
        }
        break;
      }

      case "call.answered": {
        const call = await prisma.call.update({
          where: { telnyxCallControlId: callControlId },
          data: { status: CallStatus.IN_PROGRESS, startedAt: new Date() },
        });
        callEventBus.publish(call.id, "call.answered", { callControlId });
        await startTranscription(callControlId);
        await speakText(callControlId, "Hi, thanks for calling! How can I help you today?");
        break;
      }

      case "call.transcription": {
        const transcript = payload.transcription_data?.transcript;
        const isFinal = payload.transcription_data?.is_final;
        if (!transcript || !isFinal) break;

        const call = await prisma.call.findUnique({ where: { telnyxCallControlId: callControlId } });
        if (!call) break;

        callEventBus.publish(call.id, "call.transcript", { transcript });
        await handleCallerUtterance(callControlId, call.id, transcript);
        break;
      }

      case "call.hangup": {
        const call = await prisma.call.update({
          where: { telnyxCallControlId: callControlId },
          data: { status: CallStatus.COMPLETED, endedAt: new Date() },
        });
        callEventBus.publish(call.id, "call.hangup", {});
        break;
      }

      default:
        break;
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Error handling Telnyx webhook event ${eventType}:`, error);
  }
}
