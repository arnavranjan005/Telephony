import { createApp } from "./app";
import { env } from "@telephony/config";
import { attachMediaStreamServer } from "./media-stream/mediaStreamServer";

const app = createApp();

const httpServer = app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Telephony server listening on port ${env.PORT} (${env.NODE_ENV})`);
});

attachMediaStreamServer(httpServer);
