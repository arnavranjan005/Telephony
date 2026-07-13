export { placeOutboundCall, finalizeDialOutcome } from "./outboundDialService";
export type { DialResult } from "./outboundDialService";

export {
  createFollowUp,
  listFollowUps,
  cancelFollowUp,
  findCancelableFollowUpId,
  processFollowUpJob,
} from "./followUpService";
export type { CreateFollowUpInput, CancelFollowUpResult } from "./followUpService";

export {
  createCampaign,
  listCampaigns,
  getCampaign,
  startCampaign,
  pauseCampaign,
  processCampaignContactJob,
} from "./campaignService";
export type { CampaignContactInput, CreateCampaignInput } from "./campaignService";

export { isNumberOnDnc, addToDnc, removeFromDnc, listDnc } from "./dncService";

export { getOverviewStats, getCampaignPerformance, getCallTimeseries } from "./analyticsService";
export type { OverviewStats, CampaignPerformance, CallTimeseriesPoint } from "./analyticsService";

export { recordConsent, revokeConsent, hasConsent } from "./consentService";

export {
  getAreaCode,
  getTimezoneForPhoneNumber,
  isWithinCallingHours,
  nextCallingWindowStart,
} from "./compliance/callingHours";

export { buildStreamUrl, issueStreamToken, verifyStreamToken } from "./mediaStream/streamAuth";

export { telnyxClient } from "./telnyx/telnyxClient";
export {
  initiateOutboundCall,
  answerCall,
  speakText,
  startTranscription,
  hangupCall,
  startRecording,
  getRecordingDownloadUrl,
  deleteRecordingsForSession,
  decodeClientState,
} from "./telnyx/callService";
export type { StreamingOptions } from "./telnyx/callService";

export { processRecordingDeletion } from "./recordingService";
