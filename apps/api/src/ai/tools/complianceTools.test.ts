const addToDnc = jest.fn();

jest.mock("@telephony/domain", () => ({
  addToDnc: (...args: unknown[]) => addToDnc(...args),
}));

import { DncSource } from "@telephony/database";
import { buildComplianceTools } from "./complianceTools";

describe("complianceTools", () => {
  it("add_to_dnc adds the bound phone number with CALLER_REQUEST source", async () => {
    addToDnc.mockResolvedValue({});

    const [addToDncTool] = buildComplianceTools({ phoneNumber: "+15551234567" });
    const result = await addToDncTool.handler({ reason: "stop calling me" });

    expect(result).toEqual({ added: true, phoneNumber: "+15551234567" });
    expect(addToDnc).toHaveBeenCalledWith("+15551234567", "stop calling me", DncSource.CALLER_REQUEST);
  });

  it("add_to_dnc is a no-op when there is no phone number in context", async () => {
    const [addToDncTool] = buildComplianceTools({});
    const result = await addToDncTool.handler({});

    expect(result).toEqual({ added: false, reason: "No phone number available for this call" });
    expect(addToDnc).not.toHaveBeenCalled();
  });
});
