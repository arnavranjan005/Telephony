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
const leadUpsert = jest.fn();
const leadCreateMany = jest.fn();
const leadFindMany = jest.fn();
const leadUpdateMany = jest.fn();

function makeTx() {
  return {
    campaign: { create: (...args: unknown[]) => campaignCreate(...args) },
    campaignContact: {
      create: (...args: unknown[]) => campaignContactCreate(...args),
      createMany: (...args: unknown[]) => campaignContactCreateMany(...args),
    },
    lead: {
      upsert: (...args: unknown[]) => leadUpsert(...args),
      createMany: (...args: unknown[]) => leadCreateMany(...args),
      findMany: (...args: unknown[]) => leadFindMany(...args),
      updateMany: (...args: unknown[]) => leadUpdateMany(...args),
    },
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

import { createCampaign, processCampaignContactJob, startCampaign } from "./campaignService";

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
        contacts: [{ phoneNumber: "+15551234567", firstName: "Jane" }],
      });

      // New phone numbers are inserted in one createMany (existing ones skipped)...
      expect(leadCreateMany).toHaveBeenCalledWith({
        data: [{ phoneNumber: "+15551234567", firstName: "Jane", lastName: undefined }],
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
