import Telnyx from "telnyx";
import { env } from "../../config/env";

export const telnyxClient = new Telnyx(env.TELNYX_API_KEY);
