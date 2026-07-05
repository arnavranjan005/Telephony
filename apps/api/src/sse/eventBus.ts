import { EventEmitter } from "events";

export type CallEvent = {
  type: string;
  /** null for dashboard-wide events (see publishGlobal) that aren't scoped to one call. */
  callId: string | null;
  data: unknown;
  timestamp: string;
};

class CallEventBus extends EventEmitter {
  publish(callId: string, type: string, data: unknown): void {
    const event: CallEvent = { type, callId, data, timestamp: new Date().toISOString() };
    this.emit(callId, event);
    this.emit("*", event);
  }

  /**
   * For lead/campaign/appointment/follow-up lifecycle events, which aren't
   * scoped to a single call. Only ever delivered to "*" (dashboard-wide)
   * subscribers - never to a per-call listener, since there's no callId to
   * match against.
   */
  publishGlobal(type: string, data: unknown): void {
    const event: CallEvent = { type, callId: null, data, timestamp: new Date().toISOString() };
    this.emit("*", event);
  }
}

export const callEventBus = new CallEventBus();
callEventBus.setMaxListeners(0);
