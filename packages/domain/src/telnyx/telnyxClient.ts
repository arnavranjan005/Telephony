import Telnyx from "telnyx";
import { env } from "@telephony/config";

export const telnyxClient = new Telnyx(env.TELNYX_API_KEY);

/**
 * The telnyx SDK's `calls.create`/`calls.retrieve` mutate the shared
 * `telnyxClient.calls` object in place (see `addResourceToResponseData` in
 * telnyx/dist/utils.js), rebinding its `answer`/`hangup`/`speak`/etc. methods
 * to whichever call was just created. Any later `telnyxClient.calls.answer(id, ...)`
 * call on the shared instance then gets a stale extra argument and throws
 * "Unknown arguments". Callers that create/retrieve a call must use a
 * throwaway client so the shared instance (used for command actions) is
 * never poisoned.
 */
export function createScopedTelnyxClient(): Telnyx {
  return new Telnyx(env.TELNYX_API_KEY);
}
