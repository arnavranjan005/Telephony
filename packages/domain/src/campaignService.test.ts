const campaignCreate = jest.fn();
const campaignFindMany = jest.fn();
const campaignFindUnique = jest.fn();
const campaignUpdate = jest.fn();
const campaignUpdateMany = jest.fn();
const campaignContactCreate = jest.fn();
const campaignContactFindMany = jest.fn();
const campaignContactUpdateMany = jest.fn();
const campaignContactUpdate = jest.fn();
const campaignContactFindUniqueOrThrow = jest.fn();
const campaignContactCount = jest.fn();
const campaignContactCreateMany = jest.fn();
const campaignContactFindManyTx = jest.fn();
const campaignContactDeleteMany = jest.fn();
const leadUpsert = jest.fn();
const leadCreateMany = jest.fn();
const leadFindMany = jest.fn();
const leadUpdateMany = jest.fn();
const leadDeleteMany = jest.fn();
const queryRawTx = jest.fn();

function makeTx() {
  return {
    campaign: {
      create: (...args: unknown[]) => campaignCreate(...args),
      findUnique: (...args: unknown[]) => campaignFindUnique(...args),
      updateMany: (...args: unknown[]) => campaignUpdateMany(...args),
    },
    campaignContact: {
      create: (...args: unknown[]) => campaignContactCreate(...args),
      createMany: (...args: unknown[]) => campaignContactCreateMany(...args),
      findMany: (...args: unknown[]) => campaignContactFindManyTx(...args),
      deleteMany: (...args: unknown[]) => campaignContactDeleteMany(...args),
    },
    lead: {
      upsert: (...args: unknown[]) => leadUpsert(...args),
      createMany: (...args: unknown[]) => leadCreateMany(...args),
      findMany: (...args: unknown[]) => leadFindMany(...args),
      updateMany: (...args: unknown[]) => leadUpdateMany(...args),
      deleteMany: (...args: unknown[]) => leadDeleteMany(...args),
    },
    $queryRaw: (...args: unknown[]) => queryRawTx(...args),
  };
}

jest.mock("@telephony/database", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => unknown) => fn(makeTx()),
    campaign: {
      create: (...args: unknown[]) => campaignCreate(...args),
      findMany: (...args: unknown[]) => campaignFindMany(...args),
      findUnique: (...args: unknown[]) => campaignFindUnique(...args),
      update: (...args: unknown[]) => campaignUpdate(...args),
      updateMany: (...args: unknown[]) => campaignUpdateMany(...args),
    },
    campaignContact: {
      create: (...args: unknown[]) => campaignContactCreate(...args),
      findMany: (...args: unknown[]) => campaignContactFindMany(...args),
      updateMany: (...args: unknown[]) => campaignContactUpdateMany(...args),
      update: (...args: unknown[]) => campaignContactUpdate(...args),
      findUniqueOrThrow: (...args: unknown[]) => campaignContactFindUniqueOrThrow(...args),
      count: (...args: unknown[]) => campaignContactCount(...args),
    },
    lead: {
      upsert: (...args: unknown[]) => leadUpsert(...args),
    },
  },
  // Trivial stand-ins - deleteCampaignLeads only uses these to build the row-
  // lock query, whose exact SQL content isn't asserted on; the mocked
  // $queryRaw above swallows whatever they produce.
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    join: (arr: unknown[]) => arr,
  },
  CampaignStatus: { DRAFT: "DRAFT", RUNNING: "RUNNING", PAUSED: "PAUSED", COMPLETED: "COMPLETED" },
  ConsentStatus: { UNKNOWN: "UNKNOWN", GRANTED: "GRANTED", REVOKED: "REVOKED" },
  CampaignContactStatus: {
    PENDING: "PENDING",
    WAITING_FOR_CALLING_HOURS: "WAITING_FOR_CALLING_HOURS",
    CALLING: "CALLING",
    CALLED: "CALLED",
    FAILED: "FAILED",
    SKIPPED_DNC: "SKIPPED_DNC",
    SKIPPED_NO_CONSENT: "SKIPPED_NO_CONSENT",
  },
}));

const placeOutboundCall = jest.fn();
jest.mock("./outboundDialService", () => ({
  placeOutboundCall: (...args: unknown[]) => placeOutboundCall(...args),
}));

const enqueueCampaignContactDial = jest.fn();
const enqueueCampaignContactDialAt = jest.fn();
jest.mock("@telephony/queue", () => ({
  enqueueCampaignContactDial: (...args: unknown[]) => enqueueCampaignContactDial(...args),
  enqueueCampaignContactDialAt: (...args: unknown[]) => enqueueCampaignContactDialAt(...args),
}));

const isWithinCallingHours = jest.fn();
const nextCallingWindowStart = jest.fn();
jest.mock("./compliance/callingHours", () => ({
  isWithinCallingHours: (...args: unknown[]) => isWithinCallingHours(...args),
  nextCallingWindowStart: (...args: unknown[]) => nextCallingWindowStart(...args),
}));

const mockEnv = { MEDIA_STREAM_ENABLED: false };
jest.mock("@telephony/config", () => ({ env: mockEnv }));

import {
  addContactsToCampaign,
  CampaignNotDraftError,
  createCampaign,
  deleteCampaignLeads,
  processCampaignContactJob,
  startCampaign,
} from "./campaignService";

beforeEach(() => {
  isWithinCallingHours.mockReturnValue(true); // default: every existing test dials as if within the legal window
  mockEnv.MEDIA_STREAM_ENABLED = false;
});

describe("campaignService", () => {
  describe("createCampaign", () => {
    it("bulk-creates a lead by phone number for contacts without a leadId, then links it", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      leadCreateMany.mockResolvedValue({ count: 1 });
      leadFindMany.mockResolvedValue([{ id: "lead_new" }]);
      campaignContactCreateMany.mockResolvedValue({ count: 1 });
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({
        name: "Spring outreach",
        script: "Ask about renewal",
        contacts: [{ phoneNumber: "+15551234567", name: "Jane" }],
      });

      // New phone numbers are inserted in one createMany (existing ones skipped)...
      expect(leadCreateMany).toHaveBeenCalledWith({
        data: [{ phoneNumber: "+15551234567", name: "Jane" }],
        skipDuplicates: true,
      });
      // ...then resolved to ids (covering new + pre-existing)...
      expect(leadFindMany).toHaveBeenCalledWith({
        where: { phoneNumber: { in: ["+15551234567"] } },
        select: { id: true },
      });
      // ...and linked in one createMany.
      expect(campaignContactCreateMany).toHaveBeenCalledWith({
        data: [{ campaignId: "camp_1", leadId: "lead_new" }],
        skipDuplicates: true,
      });
      expect(leadUpsert).not.toHaveBeenCalled();
    });

    it("defaults a new campaign's streamingEnabled to true when not specified", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({ name: "Spring outreach", script: "Ask about renewal", contacts: [] });

      expect(campaignCreate).toHaveBeenCalledWith({
        data: { name: "Spring outreach", script: "Ask about renewal", streamingEnabled: true },
      });
    });

    it("respects an explicit streamingEnabled: false opt-out on a new campaign", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({
        name: "Spring outreach",
        script: "Ask about renewal",
        streamingEnabled: false,
        contacts: [],
      });

      expect(campaignCreate).toHaveBeenCalledWith({
        data: { name: "Spring outreach", script: "Ask about renewal", streamingEnabled: false },
      });
    });

    it("persists an objectionPlaybook when provided", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({
        name: "Spring outreach",
        script: "Ask about renewal",
        objectionPlaybook: "If price is the objection, mention the 3-installment plan",
        contacts: [],
      });

      expect(campaignCreate).toHaveBeenCalledWith({
        data: {
          name: "Spring outreach",
          script: "Ask about renewal",
          objectionPlaybook: "If price is the objection, mention the 3-installment plan",
          streamingEnabled: true,
        },
      });
    });

    it("persists an openingLine when provided", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({
        name: "Spring outreach",
        script: "Ask about renewal",
        openingLine: "Hi, this is Acquire Right calling about the quote you requested.",
        contacts: [],
      });

      expect(campaignCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          openingLine: "Hi, this is Acquire Right calling about the quote you requested.",
        }),
      });
    });

    it("leaves objectionPlaybook undefined when not provided", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({ name: "Spring outreach", script: "Ask about renewal", contacts: [] });

      expect(campaignCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ objectionPlaybook: undefined }),
      });
    });

    it("links a given leadId directly without creating a lead", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      campaignContactCreateMany.mockResolvedValue({ count: 1 });
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({
        name: "Spring outreach",
        script: "Ask about renewal",
        contacts: [{ leadId: "lead_existing" }],
      });

      expect(leadCreateMany).not.toHaveBeenCalled();
      expect(leadFindMany).not.toHaveBeenCalled();
      expect(campaignContactCreateMany).toHaveBeenCalledWith({
        data: [{ campaignId: "camp_1", leadId: "lead_existing" }],
        skipDuplicates: true,
      });
    });

    it("grants consent to every lead in the campaign when consentGrantedAll is set", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      leadCreateMany.mockResolvedValue({ count: 1 });
      leadFindMany.mockResolvedValue([{ id: "lead_new" }]);
      leadUpdateMany.mockResolvedValue({ count: 2 });
      campaignContactCreateMany.mockResolvedValue({ count: 2 });
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({
        name: "Spring outreach",
        script: "Ask about renewal",
        contacts: [{ leadId: "lead_existing" }, { phoneNumber: "+15551234567" }],
        consentGrantedAll: true,
      });

      // A single updateMany grants consent to the picked lead and the new one,
      // skipping any that are already GRANTED.
      expect(leadUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["lead_existing", "lead_new"] }, consentStatus: { not: "GRANTED" } },
        data: { consentStatus: "GRANTED", consentSource: "campaign", consentedAt: expect.any(Date) },
      });
    });

    it("does not touch consent when consentGrantedAll is not set", async () => {
      campaignCreate.mockResolvedValue({ id: "camp_1" });
      leadCreateMany.mockResolvedValue({ count: 1 });
      leadFindMany.mockResolvedValue([{ id: "lead_new" }]);
      campaignContactCreateMany.mockResolvedValue({ count: 1 });
      campaignFindUnique.mockResolvedValue({ id: "camp_1", contacts: [] });

      await createCampaign({
        name: "Spring outreach",
        script: "Ask about renewal",
        contacts: [{ phoneNumber: "+15551234567" }],
      });

      expect(leadUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe("addContactsToCampaign", () => {
    // The DRAFT check is an atomic conditional updateMany (see the doc
    // comment in campaignService.ts), not a plain read - it both verifies and
    // "claims" the campaign as still DRAFT for the rest of the transaction, so
    // a concurrent startCampaign() can't race the check against the insert.
    // A count of 0 means either the campaign doesn't exist or it's no longer
    // DRAFT; the fallback findUnique below only runs in that (rare) branch to
    // tell those two cases apart.

    it("returns null when the campaign doesn't exist, without writing anything", async () => {
      campaignUpdateMany.mockResolvedValue({ count: 0 });
      campaignFindUnique.mockResolvedValue(null);

      const result = await addContactsToCampaign("camp_missing", [{ phoneNumber: "+15551234567" }]);

      expect(result).toBeNull();
      expect(leadCreateMany).not.toHaveBeenCalled();
      expect(campaignContactCreateMany).not.toHaveBeenCalled();
    });

    it("throws CampaignNotDraftError for a campaign that already started, without writing anything", async () => {
      campaignUpdateMany.mockResolvedValue({ count: 0 }); // claim missed - status is no longer DRAFT
      campaignFindUnique.mockResolvedValue({ id: "camp_1", status: "RUNNING" });

      await expect(addContactsToCampaign("camp_1", [{ phoneNumber: "+15551234567" }])).rejects.toThrow(
        CampaignNotDraftError
      );
      expect(leadCreateMany).not.toHaveBeenCalled();
      expect(campaignContactCreateMany).not.toHaveBeenCalled();
    });

    it("links new and existing leads to a DRAFT campaign, reporting counts from skipDuplicates", async () => {
      campaignUpdateMany.mockResolvedValue({ count: 1 }); // claimed: still DRAFT
      leadCreateMany.mockResolvedValue({ count: 1 });
      leadFindMany.mockResolvedValue([{ id: "lead_new" }]);
      // 2 leads resolved (lead_existing picked directly + lead_new by phone),
      // but only 1 actually inserted - the unique(campaignId, leadId)
      // constraint made the DB skip lead_existing as already-linked.
      campaignContactCreateMany.mockResolvedValue({ count: 1 });
      // Only reached by getCampaign() after the transaction now (the claim
      // above replaces the old pre-insert findUnique read).
      campaignFindUnique.mockResolvedValue({ id: "camp_1", status: "DRAFT", contacts: [] });

      const result = await addContactsToCampaign(
        "camp_1",
        [{ leadId: "lead_existing" }, { phoneNumber: "+15551234567" }],
        undefined
      );

      expect(campaignUpdateMany).toHaveBeenCalledWith({
        where: { id: "camp_1", status: "DRAFT" },
        data: { updatedAt: expect.any(Date) },
      });
      expect(campaignContactCreateMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          { campaignId: "camp_1", leadId: "lead_existing" },
          { campaignId: "camp_1", leadId: "lead_new" },
        ]),
        skipDuplicates: true,
      });
      expect(result).toMatchObject({ added: 1, alreadyInCampaign: 1 });
    });

    it("grants consent to resolved leads when consentGrantedAll is set", async () => {
      campaignUpdateMany.mockResolvedValue({ count: 1 });
      campaignFindUnique.mockResolvedValue({ id: "camp_1", status: "DRAFT", contacts: [] });
      leadCreateMany.mockResolvedValue({ count: 1 });
      leadFindMany.mockResolvedValue([{ id: "lead_new" }]);
      campaignContactCreateMany.mockResolvedValue({ count: 1 });

      await addContactsToCampaign("camp_1", [{ phoneNumber: "+15551234567" }], true);

      expect(leadUpdateMany).toHaveBeenCalledWith({
        where: { id: { in: ["lead_new"] }, consentStatus: { not: "GRANTED" } },
        data: { consentStatus: "GRANTED", consentSource: "campaign", consentedAt: expect.any(Date) },
      });
    });
  });

  describe("deleteCampaignLeads", () => {
    it("returns null when the campaign doesn't exist, without writing anything", async () => {
      campaignUpdateMany.mockResolvedValue({ count: 0 });
      campaignFindUnique.mockResolvedValue(null);

      const result = await deleteCampaignLeads("camp_missing");

      expect(result).toBeNull();
      expect(campaignContactFindManyTx).not.toHaveBeenCalled();
      expect(leadDeleteMany).not.toHaveBeenCalled();
    });

    it("throws CampaignNotDraftError for a campaign that already started, without writing anything", async () => {
      campaignUpdateMany.mockResolvedValue({ count: 0 });
      campaignFindUnique.mockResolvedValue({ id: "camp_1", status: "RUNNING" });

      await expect(deleteCampaignLeads("camp_1")).rejects.toThrow(CampaignNotDraftError);
      expect(campaignContactFindManyTx).not.toHaveBeenCalled();
      expect(leadDeleteMany).not.toHaveBeenCalled();
    });

    it("is a no-op when the campaign has no contacts", async () => {
      campaignUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindManyTx.mockResolvedValue([]);
      campaignFindUnique.mockResolvedValue({ id: "camp_1", status: "DRAFT", contacts: [] });

      const result = await deleteCampaignLeads("camp_1");

      expect(result).toMatchObject({ deleted: 0, skipped: 0, skippedLeads: [] });
      expect(leadFindMany).not.toHaveBeenCalled();
      expect(leadDeleteMany).not.toHaveBeenCalled();
    });

    it("deletes leads with no history that are only attached to this campaign", async () => {
      campaignUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindManyTx.mockResolvedValue([{ leadId: "lead_1" }, { leadId: "lead_2" }]);
      leadFindMany.mockResolvedValue([
        { id: "lead_1", name: "Lead One", phoneNumber: "+15551110001", _count: { calls: 0, appointments: 0, followUps: 0, campaignContacts: 1 } },
        { id: "lead_2", name: "Lead Two", phoneNumber: "+15551110002", _count: { calls: 0, appointments: 0, followUps: 0, campaignContacts: 1 } },
      ]);
      campaignFindUnique.mockResolvedValue({ id: "camp_1", status: "DRAFT", contacts: [] });
      leadDeleteMany.mockResolvedValue({ count: 2 });

      const result = await deleteCampaignLeads("camp_1");

      // Locks every candidate lead row before reading _count, so a
      // concurrent write against one of them (a new call/appointment/
      // follow-up, or a different campaign attaching it) blocks until this
      // transaction finishes instead of racing the read - see the doc
      // comment in campaignService.ts. That makes the plain deletes below
      // safe without re-checking cleanliness live.
      expect(queryRawTx).toHaveBeenCalledWith(expect.objectContaining({ values: [["lead_1", "lead_2"]] }));
      expect(campaignContactDeleteMany).toHaveBeenCalledWith({
        where: { campaignId: "camp_1", leadId: { in: ["lead_1", "lead_2"] } },
      });
      expect(leadDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["lead_1", "lead_2"] } } });
      expect(result).toMatchObject({ deleted: 2, skipped: 0, skippedLeads: [] });
    });

    it("skips a lead with call history, an appointment, a follow-up, or another campaign attachment, reporting why", async () => {
      campaignUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindManyTx.mockResolvedValue([
        { leadId: "lead_clean" },
        { leadId: "lead_has_call" },
        { leadId: "lead_has_appt" },
        { leadId: "lead_has_followup" },
        { leadId: "lead_in_other_campaign" },
      ]);
      leadFindMany.mockResolvedValue([
        { id: "lead_clean", name: "Clean Co", phoneNumber: "+15551110000", _count: { calls: 0, appointments: 0, followUps: 0, campaignContacts: 1 } },
        { id: "lead_has_call", name: "Has Call Co", phoneNumber: "+15551110001", _count: { calls: 2, appointments: 0, followUps: 0, campaignContacts: 1 } },
        { id: "lead_has_appt", name: "Has Appt Co", phoneNumber: "+15551110002", _count: { calls: 0, appointments: 1, followUps: 0, campaignContacts: 1 } },
        { id: "lead_has_followup", name: "Has Followup Co", phoneNumber: "+15551110003", _count: { calls: 0, appointments: 0, followUps: 1, campaignContacts: 1 } },
        { id: "lead_in_other_campaign", name: null, phoneNumber: "+15551110004", _count: { calls: 0, appointments: 0, followUps: 0, campaignContacts: 2 } },
      ]);
      campaignFindUnique.mockResolvedValue({ id: "camp_1", status: "DRAFT", contacts: [] });
      leadDeleteMany.mockResolvedValue({ count: 1 });

      const result = await deleteCampaignLeads("camp_1");

      expect(campaignContactDeleteMany).toHaveBeenCalledWith({
        where: { campaignId: "camp_1", leadId: { in: ["lead_clean"] } },
      });
      expect(leadDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["lead_clean"] } } });
      expect(result).toMatchObject({
        deleted: 1,
        skipped: 4,
        skippedLeads: [
          { id: "lead_has_call", name: "Has Call Co", phoneNumber: "+15551110001", reason: "2 calls" },
          { id: "lead_has_appt", name: "Has Appt Co", phoneNumber: "+15551110002", reason: "1 appointment" },
          { id: "lead_has_followup", name: "Has Followup Co", phoneNumber: "+15551110003", reason: "1 follow-up" },
          { id: "lead_in_other_campaign", name: null, phoneNumber: "+15551110004", reason: "in 1 other campaign" },
        ],
      });
    });
  });

  describe("startCampaign", () => {
    it("flips status to RUNNING and enqueues a dial job per PENDING contact", async () => {
      campaignUpdate.mockResolvedValue({ id: "camp_1", status: "RUNNING" });
      campaignContactFindMany.mockResolvedValue([{ id: "cc_1" }, { id: "cc_2" }]);

      await startCampaign("camp_1");

      expect(campaignUpdate).toHaveBeenCalledWith({ where: { id: "camp_1" }, data: { status: "RUNNING" } });
      expect(enqueueCampaignContactDial).toHaveBeenCalledWith("cc_1");
      expect(enqueueCampaignContactDial).toHaveBeenCalledWith("cc_2");
    });
  });

  describe("processCampaignContactJob", () => {
    it("claims the row, dials, and marks the campaign COMPLETED once nothing PENDING remains", async () => {
      campaignContactUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
        campaign: { streamingEnabled: false },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });
      campaignContactCount.mockResolvedValue(0);

      await processCampaignContactJob("cc_1");

      expect(campaignContactUpdateMany).toHaveBeenCalledWith({
        where: { id: "cc_1", status: { in: ["PENDING", "WAITING_FOR_CALLING_HOURS"] }, campaign: { status: "RUNNING" } },
        data: { status: "CALLING", attemptedAt: expect.any(Date) },
      });
      expect(campaignContactUpdate).toHaveBeenCalledWith({ where: { id: "cc_1" }, data: { callId: "call_1" } });
      expect(campaignUpdateMany).toHaveBeenCalledWith({
        where: { id: "camp_1", status: "RUNNING" },
        data: { status: "COMPLETED" },
      });
      expect(placeOutboundCall).toHaveBeenCalledWith("+15551234567", "lead_1", {
        requireConsent: true,
        streamingEnabled: false,
      });
    });

    it("does not complete the campaign while PENDING contacts remain", async () => {
      campaignContactUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
        campaign: { streamingEnabled: false },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });
      campaignContactCount.mockResolvedValue(3);

      await processCampaignContactJob("cc_1");

      expect(campaignUpdateMany).not.toHaveBeenCalled();
    });

    it("is a no-op when the row is no longer PENDING (already claimed elsewhere)", async () => {
      campaignContactUpdateMany.mockResolvedValue({ count: 0 });

      await processCampaignContactJob("cc_1");

      expect(campaignContactFindUniqueOrThrow).not.toHaveBeenCalled();
      expect(placeOutboundCall).not.toHaveBeenCalled();
    });

    it("does not dial and leaves the contact PENDING when the campaign is not RUNNING (e.g. PAUSED)", async () => {
      // The claim's WHERE requires campaign.status === RUNNING, so a paused
      // campaign's row simply fails to match - same "count: 0" no-op path as
      // any other failed claim, just for a different reason.
      campaignContactUpdateMany.mockResolvedValue({ count: 0 });

      await processCampaignContactJob("cc_1");

      expect(campaignContactUpdateMany).toHaveBeenCalledWith({
        where: { id: "cc_1", status: { in: ["PENDING", "WAITING_FOR_CALLING_HOURS"] }, campaign: { status: "RUNNING" } },
        data: { status: "CALLING", attemptedAt: expect.any(Date) },
      });
      expect(campaignContactFindUniqueOrThrow).not.toHaveBeenCalled();
      expect(placeOutboundCall).not.toHaveBeenCalled();
    });

    it("proves distributed-safety: a second concurrent claim attempt on the same row is a no-op", async () => {
      campaignContactUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
        campaign: { streamingEnabled: false },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });
      campaignContactCount.mockResolvedValue(0);

      await Promise.all([processCampaignContactJob("cc_1"), processCampaignContactJob("cc_1")]);

      expect(placeOutboundCall).toHaveBeenCalledTimes(1);
    });

    it("marks a failed dial FAILED and links the call for the failure reason", async () => {
      campaignContactUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
        campaign: { streamingEnabled: false },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "failed", error: "boom", callId: "call_1" });
      campaignContactCount.mockResolvedValue(0);

      await processCampaignContactJob("cc_1");

      expect(campaignContactUpdate).toHaveBeenCalledWith({
        where: { id: "cc_1" },
        data: { status: "FAILED", callId: "call_1" },
      });
    });

    it("marks a contact without on-file consent SKIPPED_NO_CONSENT", async () => {
      campaignContactUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
        campaign: { streamingEnabled: false },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "skipped_no_consent" });
      campaignContactCount.mockResolvedValue(0);

      await processCampaignContactJob("cc_1");

      expect(campaignContactUpdate).toHaveBeenCalledWith({
        where: { id: "cc_1" },
        data: { status: "SKIPPED_NO_CONSENT" },
      });
    });

    it("outside the legal calling window: marks WAITING_FOR_CALLING_HOURS and reschedules for the next window instead of dialing", async () => {
      campaignContactUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+12125551234" },
        campaign: { streamingEnabled: false },
      });
      isWithinCallingHours.mockReturnValue(false);
      const nextWindow = new Date("2026-01-16T13:00:00Z");
      nextCallingWindowStart.mockReturnValue(nextWindow);

      await processCampaignContactJob("cc_1");

      expect(placeOutboundCall).not.toHaveBeenCalled();
      expect(campaignContactUpdate).toHaveBeenCalledWith({
        where: { id: "cc_1" },
        data: { status: "WAITING_FOR_CALLING_HOURS" },
      });
      expect(enqueueCampaignContactDialAt).toHaveBeenCalledWith("cc_1", nextWindow);
      expect(campaignContactCount).not.toHaveBeenCalled(); // not exhausted-checked; the contact isn't done, just deferred
    });

    it("marks a DNC-listed contact SKIPPED_DNC", async () => {
      campaignContactUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
        campaign: { streamingEnabled: false },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "skipped_dnc" });
      campaignContactCount.mockResolvedValue(0);

      await processCampaignContactJob("cc_1");

      expect(campaignContactUpdate).toHaveBeenCalledWith({
        where: { id: "cc_1" },
        data: { status: "SKIPPED_DNC" },
      });
    });

    it("dials with streamingEnabled: true when the campaign opted in and MEDIA_STREAM_ENABLED is globally on", async () => {
      mockEnv.MEDIA_STREAM_ENABLED = true;
      campaignContactUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
        campaign: { streamingEnabled: true },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });
      campaignContactCount.mockResolvedValue(0);

      await processCampaignContactJob("cc_1");

      expect(placeOutboundCall).toHaveBeenCalledWith("+15551234567", "lead_1", {
        requireConsent: true,
        streamingEnabled: true,
      });
    });

    it("does not dial with streaming when the campaign opted in but MEDIA_STREAM_ENABLED is globally off", async () => {
      mockEnv.MEDIA_STREAM_ENABLED = false;
      campaignContactUpdateMany.mockResolvedValue({ count: 1 });
      campaignContactFindUniqueOrThrow.mockResolvedValue({
        id: "cc_1",
        leadId: "lead_1",
        campaignId: "camp_1",
        lead: { phoneNumber: "+15551234567" },
        campaign: { streamingEnabled: true },
      });
      placeOutboundCall.mockResolvedValue({ outcome: "dialed", callId: "call_1" });
      campaignContactCount.mockResolvedValue(0);

      await processCampaignContactJob("cc_1");

      expect(placeOutboundCall).toHaveBeenCalledWith("+15551234567", "lead_1", {
        requireConsent: true,
        streamingEnabled: false,
      });
    });
  });
});
