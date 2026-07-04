export { placeOutboundCall, finalizeDialOutcome } from "./outboundDialService";
export type { DialResult } from "./outboundDialService";

export {
  createFollowUp,
  listFollowUps,
  cancelFollowUp,
  processFollowUpJob,
} from "./followUpService";
export type { CreateFollowUpInput } from "./followUpService";

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

export { telnyxClient } from "./telnyx/telnyxClient";
export {
  initiateOutboundCall,
  answerCall,
  speakText,
  startTranscription,
  hangupCall,
  decodeClientState,
} from "./telnyx/callService";
