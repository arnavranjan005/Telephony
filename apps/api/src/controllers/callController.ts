import { Request, Response } from "express";
import { Readable } from "node:stream";
import { z } from "zod";
import { env } from "@telephony/config";
import { prisma, CallStatus, CallDirection } from "@telephony/database";
import {
  answerCall,
  decodeClientState,
  speakText,
  startTranscription,
  placeOutboundCall,
  finalizeDialOutcome,
  buildStreamUrl,
  hangupCall,
  startRecording,
  getRecordingDownloadUrl,
} from "@telephony/domain";
import { enqueueRecordingDeletion } from "@telephony/queue";
import { verifyTelnyxSignature } from "../telnyx/webhookVerifier";
import { handleCallerUtterance } from "../callConversationService";
import { callEventBus } from "../sse/eventBus";

const outboundCallSchema = z.object({
  toNumber: z.string().min(1),
  leadId: z.string().optional(),
  // Media streaming (barge-in) is on by default for every call - pass
  // `streaming: false` to opt this call out and use the legacy webhook flow
  // instead. Still gated by the global MEDIA_STREAM_ENABLED flag either way.
  streaming: z.boolean().optional(),
});

export async function createOutboundCall(req: Request, res: Response) {
  const parsed = outboundCallSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { toNumber, leadId, streaming } = parsed.data;

  const result = await placeOutboundCall(toNumber, leadId, {
    streamingEnabled: (streaming ?? true) && env.MEDIA_STREAM_ENABLED,
  });

  if (result.outcome === "skipped_dnc") {
    return res.status(403).json({ error: "This number is on the Do-Not-Call list" });
  }
  if (result.outcome === "skipped_no_consent") {
    return res.status(403).json({ error: "This lead has not granted consent to be contacted" });
  }
  if (result.outcome === "failed") {
    return res.status(502).json({ error: result.error });
  }

  const call = await prisma.call.findUnique({ where: { id: result.callId } });
  callEventBus.publishGlobal("call.created", { call });
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

/**
 * Streams the call's recording audio through the API. We mint a fresh Telnyx
 * download URL per request (from the stored call_session_id, since the raw
 * URLs expire in ~10 minutes) and proxy the bytes, rather than redirecting to
 * Telnyx directly: Telnyx's signed URLs are cross-origin and send no CORS
 * headers, so a browser <audio> element can't reliably follow a redirect to
 * them for its range requests. Proxying keeps the media same-origin and
 * forwards HTTP Range so seeking works. Add ?download=1 to force a file
 * download instead of inline playback. Returns 404 if the call has no
 * recording, or if it's already been deleted after the retention window.
 */
export async function getCallRecording(req: Request, res: Response) {
  const call = await prisma.call.findUnique({
    where: { id: req.params.callId },
    select: { id: true, telnyxCallSessionId: true },
  });
  if (!call) return res.status(404).json({ error: "Call not found" });
  if (!call.telnyxCallSessionId) {
    return res.status(404).json({ error: "No recording available for this call" });
  }

  const downloadUrl = await getRecordingDownloadUrl(call.telnyxCallSessionId);
  if (!downloadUrl) {
    return res.status(404).json({ error: "Recording is no longer available" });
  }

  const range = req.header("range");
  const upstream = await fetch(downloadUrl, { headers: range ? { Range: range } : {} });
  if (!upstream.ok) {
    return res.status(502).json({ error: "Failed to fetch recording from Telnyx" });
  }

  res.status(upstream.status); // 206 when a Range was served, else 200
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");
  // The admin panel is served from a different origin than this API, so
  // helmet's default Cross-Origin-Resource-Policy: same-origin would block a
  // browser <audio>/<a download> from loading this response. Allow it.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  for (const header of ["content-length", "content-range"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  const disposition = req.query.download !== undefined ? "attachment" : "inline";
  res.setHeader("Content-Disposition", `${disposition}; filename="call-${call.id}.mp3"`);

  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
}

type TelnyxWebhookPayload = {
  data?: {
    event_type?: string;
    payload?: {
      call_control_id?: string;
      call_session_id?: string;
      client_state?: string;
      from?: string;
      to?: string;
      hangup_cause?: string;
      transcription_data?: { transcript?: string; is_final?: boolean };
      recording_urls?: { mp3?: string | null; wav?: string | null };
    };
  };
};

/**
 * Maps Telnyx's hangup_cause (see
 * https://developers.telnyx.com/docs/voice/programmable-voice/receiving-webhooks)
 * to our CallStatus. If the call was already IN_PROGRESS (call.answered
 * fired), the conversation genuinely happened - it's COMPLETED regardless of
 * cause. Otherwise the cause tells us why it never connected.
 */
function mapHangupToStatus(hangupCause: string | undefined, wasAnswered: boolean): CallStatus {
  if (wasAnswered) return CallStatus.COMPLETED;

  switch (hangupCause) {
    case "user_busy":
      return CallStatus.BUSY;
    case "no_answer":
    case "timeout":
      return CallStatus.NO_ANSWER;
    case "originator_cancel":
      return CallStatus.CANCELED;
    default:
      return CallStatus.FAILED;
  }
}

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
        // (Outbound calls already have a Call row created before Telnyx is
        // called, so this branch only ever runs for genuine inbound calls.)
        let call = await prisma.call.findUnique({ where: { telnyxCallControlId: callControlId } });
        if (!call) {
          // Auto-link (or create) the Lead for this caller by phone number,
          // so inbound callers are tracked the same way outbound/campaign
          // contacts are, without requiring a lead to already exist.
          let leadId: string | undefined;
          if (payload.from) {
            const lead = await prisma.lead.upsert({
              where: { phoneNumber: payload.from },
              update: {},
              create: { phoneNumber: payload.from },
            });
            leadId = lead.id;
          }

          call = await prisma.call.create({
            data: {
              telnyxCallControlId: callControlId,
              direction: CallDirection.INBOUND,
              status: CallStatus.RINGING,
              fromNumber: payload.from ?? "unknown",
              toNumber: payload.to ?? "unknown",
              leadId,
              streamingEnabled: env.MEDIA_STREAM_ENABLED,
            },
          });
          callEventBus.publishGlobal("call.created", { call });
        }
        if (clientStateCallId === undefined) {
          const streaming = call.streamingEnabled
            ? { streamUrl: await buildStreamUrl(call.id), streamTrack: "both_tracks" as const, bidirectionalCodec: "L16" }
            : undefined;
          await answerCall(callControlId, streaming, true);
        }
        break;
      }

      case "call.recording.saved": {
        const call = await prisma.call.findUnique({ where: { telnyxCallControlId: callControlId } });
        // The webhook's own recording_urls are signed links that expire in ~10
        // minutes, so we don't persist them. Instead we keep call_session_id
        // (the durable handle) and expose a stable in-app URL that mints a
        // fresh Telnyx download link on each request (see getCallRecording).
        const callSessionId = payload.call_session_id;
        if (call && callSessionId) {
          await prisma.call.update({
            where: { id: call.id },
            data: {
              telnyxCallSessionId: callSessionId,
              recordingUrl: `${env.BASE_URL}/api/calls/${call.id}/recording`,
            },
          });
          // Enforce the retention window: schedule the recording's deletion
          // from Telnyx (which otherwise keeps it ~1 year) after
          // RECORDING_RETENTION_HOURS.
          await enqueueRecordingDeletion(call.id, env.RECORDING_RETENTION_HOURS);
        }
        break;
      }

      case "call.answered": {
        const call = await prisma.call.update({
          where: { telnyxCallControlId: callControlId },
          data: { status: CallStatus.IN_PROGRESS, startedAt: new Date() },
        });
        callEventBus.publish(call.id, "call.answered", { callControlId });
        if (call.direction === CallDirection.OUTBOUND) {
          // Inbound calls request recording inline via answerCall's
          // record-from-answer param; outbound has no dial-time equivalent
          // (see callService.ts's startRecording comment), so it's started
          // explicitly here instead, once Telnyx confirms the far end
          // actually picked up.
          await startRecording(callControlId);
        }
        if (call.streamingEnabled) {
          // Streaming calls greet the caller and start transcription from
          // within CallStreamSession once Telnyx's media-stream "start" frame
          // confirms the channel is live, not from this webhook.
          break;
        }
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

      case "call.speak.ended": {
        // Only relevant when the end_call tool flagged this call to end (see
        // callControlTools.ts) - every other speak action (greetings, normal
        // replies) is a no-op here. Waiting for the speak to actually finish
        // (rather than hanging up right after issuing the speak command)
        // means the model's own farewell line is never cut off mid-sentence.
        const call = await prisma.call.findUnique({ where: { telnyxCallControlId: callControlId } });
        if (call?.endCallRequested) {
          await hangupCall(callControlId);
        }
        break;
      }

      case "call.hangup": {
        const existingCall = await prisma.call.findUnique({ where: { telnyxCallControlId: callControlId } });
        const wasAnswered = existingCall?.status === CallStatus.IN_PROGRESS;
        const status = mapHangupToStatus(payload.hangup_cause, wasAnswered);
        const endedAt = new Date();
        const durationSeconds = existingCall?.startedAt
          ? Math.max(0, Math.round((endedAt.getTime() - existingCall.startedAt.getTime()) / 1000))
          : null;

        const call = await prisma.call.update({
          where: { telnyxCallControlId: callControlId },
          data: { status, endedAt, durationSeconds, outcome: payload.hangup_cause ?? null },
        });
        await finalizeDialOutcome(call.id, status);
        callEventBus.publish(call.id, "call.hangup", { hangupCause: payload.hangup_cause, status });
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
