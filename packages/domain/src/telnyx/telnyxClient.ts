import Telnyx from "telnyx";
import { env } from "@telephony/config";

export const telnyxClient = new Telnyx(env.TELNYX_API_KEY);
