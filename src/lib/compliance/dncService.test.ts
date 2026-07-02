const dncFindUnique = jest.fn();
const dncUpsert = jest.fn();
const dncDeleteMany = jest.fn();
const dncFindMany = jest.fn();

jest.mock("../../config/prisma", () => ({
  prisma: {
    dncEntry: {
      findUnique: (...args: unknown[]) => dncFindUnique(...args),
      upsert: (...args: unknown[]) => dncUpsert(...args),
      deleteMany: (...args: unknown[]) => dncDeleteMany(...args),
      findMany: (...args: unknown[]) => dncFindMany(...args),
    },
  },
}));

import { addToDnc, isNumberOnDnc, listDnc, removeFromDnc } from "./dncService";
import { DncSource } from "@prisma/client";

describe("dncService", () => {
  it("isNumberOnDnc returns true when an entry exists", async () => {
    dncFindUnique.mockResolvedValue({ id: "dnc_1", phoneNumber: "+15551234567" });
    expect(await isNumberOnDnc("+15551234567")).toBe(true);
  });

  it("isNumberOnDnc returns false when no entry exists", async () => {
    dncFindUnique.mockResolvedValue(null);
    expect(await isNumberOnDnc("+15551234567")).toBe(false);
  });

  it("addToDnc upserts by phone number with the given reason/source", async () => {
    dncUpsert.mockResolvedValue({ id: "dnc_1", phoneNumber: "+15551234567", source: DncSource.CALLER_REQUEST });

    await addToDnc("+15551234567", "asked to stop calling", DncSource.CALLER_REQUEST);

    expect(dncUpsert).toHaveBeenCalledWith({
      where: { phoneNumber: "+15551234567" },
      update: { reason: "asked to stop calling", source: DncSource.CALLER_REQUEST },
      create: { phoneNumber: "+15551234567", reason: "asked to stop calling", source: DncSource.CALLER_REQUEST },
    });
  });

  it("addToDnc defaults source to MANUAL", async () => {
    dncUpsert.mockResolvedValue({});
    await addToDnc("+15551234567");
    expect(dncUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ source: DncSource.MANUAL }) })
    );
  });

  it("removeFromDnc deletes by phone number", async () => {
    dncDeleteMany.mockResolvedValue({ count: 1 });
    await removeFromDnc("+15551234567");
    expect(dncDeleteMany).toHaveBeenCalledWith({ where: { phoneNumber: "+15551234567" } });
  });

  it("listDnc returns all entries", async () => {
    dncFindMany.mockResolvedValue([{ id: "dnc_1" }]);
    const entries = await listDnc();
    expect(entries).toHaveLength(1);
  });
});
