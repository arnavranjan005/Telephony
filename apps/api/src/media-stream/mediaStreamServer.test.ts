const handleUpgrade = jest.fn();
const verifyStreamToken = jest.fn();
const sessionStart = jest.fn().mockResolvedValue(undefined);
const sessionHandleTelnyxFrame = jest.fn();
const sessionClose = jest.fn();
// jest.fn() (unlike a plain arrow function) is constructible, matching that
// the real code does `new CallStreamSession(...)`.
const CallStreamSessionCtor = jest.fn().mockImplementation((options: unknown) => ({
  options,
  start: sessionStart,
  handleTelnyxFrame: sessionHandleTelnyxFrame,
  close: sessionClose,
}));

const mockEnv = { MEDIA_STREAM_ENABLED: true, MEDIA_STREAM_WS_PATH: "/media-stream" };

jest.mock("ws", () => ({
  WebSocketServer: jest.fn().mockImplementation(() => ({ handleUpgrade })),
  WebSocket: { OPEN: 1 },
}));

jest.mock("@telephony/config", () => ({ env: mockEnv }));

jest.mock("@telephony/domain", () => ({ verifyStreamToken: (...args: unknown[]) => verifyStreamToken(...args) }));

jest.mock("./callStreamSession", () => ({
  CallStreamSession: CallStreamSessionCtor,
}));

import { EventEmitter } from "events";
import type { Server } from "http";
import { attachMediaStreamServer } from "./mediaStreamServer";

function makeHttpServer(): Server {
  return new EventEmitter() as unknown as Server;
}

function makeFakeSocket() {
  return { destroy: jest.fn() };
}

describe("attachMediaStreamServer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnv.MEDIA_STREAM_ENABLED = true;
    mockEnv.MEDIA_STREAM_WS_PATH = "/media-stream";
    verifyStreamToken.mockReturnValue(true);
  });

  it("does not register an upgrade handler when MEDIA_STREAM_ENABLED is false", () => {
    mockEnv.MEDIA_STREAM_ENABLED = false;
    const httpServer = makeHttpServer();
    const onSpy = jest.spyOn(httpServer, "on");

    attachMediaStreamServer(httpServer);

    expect(onSpy).not.toHaveBeenCalled();
  });

  it("destroys the socket for a request on the wrong path", () => {
    const httpServer = makeHttpServer();
    attachMediaStreamServer(httpServer);
    const socket = makeFakeSocket();

    httpServer.emit("upgrade", { url: "/not-media-stream?callId=call_1&token=abc" }, socket, Buffer.alloc(0));

    expect(socket.destroy).toHaveBeenCalled();
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  it("destroys the socket when callId or token is missing", () => {
    const httpServer = makeHttpServer();
    attachMediaStreamServer(httpServer);
    const socket = makeFakeSocket();

    httpServer.emit("upgrade", { url: "/media-stream?callId=call_1" }, socket, Buffer.alloc(0));

    expect(socket.destroy).toHaveBeenCalled();
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  it("destroys the socket when the token fails verification", () => {
    verifyStreamToken.mockReturnValue(false);
    const httpServer = makeHttpServer();
    attachMediaStreamServer(httpServer);
    const socket = makeFakeSocket();

    httpServer.emit("upgrade", { url: "/media-stream?callId=call_1&token=bad" }, socket, Buffer.alloc(0));

    expect(verifyStreamToken).toHaveBeenCalledWith("call_1", "bad");
    expect(socket.destroy).toHaveBeenCalled();
    expect(handleUpgrade).not.toHaveBeenCalled();
  });

  it("accepts the upgrade for a valid path/callId/token and constructs a session once the start frame arrives", async () => {
    const httpServer = makeHttpServer();
    attachMediaStreamServer(httpServer);
    const socket = makeFakeSocket();

    httpServer.emit("upgrade", { url: "/media-stream?callId=call_1&token=good" }, socket, Buffer.alloc(0));

    expect(verifyStreamToken).toHaveBeenCalledWith("call_1", "good");
    expect(handleUpgrade).toHaveBeenCalled();

    // Simulate ws's handleUpgrade invoking its callback with a fake connected WebSocket.
    const upgradeCallback = handleUpgrade.mock.calls[0][3];
    const fakeWs = Object.assign(new EventEmitter(), { readyState: 1, send: jest.fn() });
    upgradeCallback(fakeWs);

    // Before "start", nothing should be constructed yet.
    fakeWs.emit("message", Buffer.from(JSON.stringify({ event: "connected", version: "1.0.0" })));
    await flushMicrotasks();
    expect(CallStreamSessionCtor).not.toHaveBeenCalled();

    const startFrame = JSON.stringify({
      event: "start",
      sequence_number: "1",
      start: { call_control_id: "ctrl_1", stream_id: "s1", media_format: {} },
    });
    fakeWs.emit("message", Buffer.from(startFrame));
    await flushMicrotasks();

    expect(CallStreamSessionCtor).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call_1", callControlId: "ctrl_1" })
    );
    expect(sessionStart).toHaveBeenCalled();
    expect(sessionHandleTelnyxFrame).toHaveBeenCalledWith(startFrame);

    fakeWs.emit("close");
    expect(sessionClose).toHaveBeenCalled();
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
