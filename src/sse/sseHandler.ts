import { Request, Response } from "express";
import { callEventBus, CallEvent } from "./eventBus";

function writeSseEvent(res: Response, event: CallEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function streamCallEvents(req: Request, res: Response): void {
  const { callId } = req.params;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ callId })}\n\n`);

  const listener = (event: CallEvent) => writeSseEvent(res, event);
  callEventBus.on(callId, listener);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    callEventBus.off(callId, listener);
    res.end();
  });
}
