import { callEventBus } from "./eventBus";

describe("callEventBus", () => {
  it("delivers published events only to listeners of that callId", () => {
    const callAListener = jest.fn();
    const callBListener = jest.fn();

    callEventBus.on("call-a", callAListener);
    callEventBus.on("call-b", callBListener);

    callEventBus.publish("call-a", "call.answered", { foo: "bar" });

    expect(callAListener).toHaveBeenCalledTimes(1);
    expect(callBListener).not.toHaveBeenCalled();

    const event = callAListener.mock.calls[0][0];
    expect(event).toMatchObject({ type: "call.answered", callId: "call-a", data: { foo: "bar" } });
    expect(typeof event.timestamp).toBe("string");

    callEventBus.off("call-a", callAListener);
    callEventBus.off("call-b", callBListener);
  });

  it("also emits every event on the wildcard '*' channel", () => {
    const wildcardListener = jest.fn();
    callEventBus.on("*", wildcardListener);

    callEventBus.publish("call-x", "call.hangup", {});

    expect(wildcardListener).toHaveBeenCalledTimes(1);
    expect(wildcardListener.mock.calls[0][0]).toMatchObject({ type: "call.hangup", callId: "call-x" });

    callEventBus.off("*", wildcardListener);
  });

  it("does not throw when publishing with no listeners", () => {
    expect(() => callEventBus.publish("no-listeners", "call.initiated", {})).not.toThrow();
  });
});
