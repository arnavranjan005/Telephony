import { EventEmitter } from "events";

export type CallEvent = {
  type: string;
  callId: string;
  data: unknown;
  timestamp: string;
};

class CallEventBus extends EventEmitter {
  publish(callId: string, type: string, data: unknown): void {
    const event: CallEvent = { type, callId, data, timestamp: new Date().toISOString() };
    this.emit(callId, event);
    this.emit("*", event);
  }
}

export const callEventBus = new CallEventBus();
callEventBus.setMaxListeners(0);
