import { Server as HttpServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { env } from "@telephony/config";
import { verifyStreamToken } from "@telephony/domain";
import { CallStreamSession } from "./callStreamSession";

/**
 * Attaches the media-streaming WebSocket endpoint to the existing apps/api
 * HTTP server (rather than a separate app/process) - see the design plan for
 * the tradeoff. Telnyx connects here once per streaming-enabled call and
 * exchanges the frames decoded by telnyxStreamProtocol.ts.
 */
export function attachMediaStreamServer(httpServer: HttpServer): void {
  if (!env.MEDIA_STREAM_ENABLED) return;

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    // verifyStreamToken is a Redis round-trip (see streamAuth.ts), so this
    // handler can't stay synchronous - wrapped in its own IIFE (rather than
    // making the "upgrade" listener itself async) so a rejection here
    // (e.g. Redis unreachable) can't become an unhandled promise rejection
    // and take down the whole server; the socket is destroyed either way.
    void (async () => {
      const url = new URL(request.url ?? "", "http://internal");
      if (url.pathname !== env.MEDIA_STREAM_WS_PATH) {
        socket.destroy();
        return;
      }

      const callId = url.searchParams.get("callId");
      const token = url.searchParams.get("token");
      if (!callId || !token || !(await verifyStreamToken(callId, token))) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        handleConnection(ws, callId);
      });
    })().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("Media stream upgrade failed:", error);
      socket.destroy();
    });
  });
}

function handleConnection(ws: WebSocket, callId: string): void {
  let session: CallStreamSession | undefined;

  ws.on("message", (data) => {
    void (async () => {
      const raw = data.toString();

      if (!session) {
        // Ignore anything before Telnyx's own "start" frame (e.g. the initial
        // "connected" handshake event) - we need its call_control_id before
        // constructing the session. Assigning `session` synchronously here
        // (before the `await session.start()` below) means a second "message"
        // event arriving while start() is still connecting to Deepgram sees
        // `session` already set and calls handleTelnyxFrame on it directly -
        // but since `session.start()` hasn't resolved yet, `this.stt` is still
        // unset, so any audio frames arriving in that brief window are
        // silently dropped rather than queued. Acceptable for this MVP (at
        // most the first ~tens of ms of audio); a Phase 2 improvement would
        // buffer frames until start() resolves.
        let callControlId: string | undefined;
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.event === "start") callControlId = parsed.start?.call_control_id;
        } catch {
          // not JSON / not a start frame yet - fall through, still ignored below
        }
        if (!callControlId) return;

        session = new CallStreamSession({
          callId,
          callControlId,
          sendToTelnyx: (frame) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(frame);
          },
        });
        await session.start();
      }

      session.handleTelnyxFrame(raw);
    })().catch((error) => {
      // eslint-disable-next-line no-console
      console.error(`Media stream error for call ${callId}:`, error);
    });
  });

  ws.on("close", () => {
    session?.close();
  });

  ws.on("error", (error) => {
    // eslint-disable-next-line no-console
    console.error(`Media stream WS error for call ${callId}:`, error);
  });
}
