import { createApp } from "./app";
import { env } from "@telephony/config";

const app = createApp();

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Telephony server listening on port ${env.PORT} (${env.NODE_ENV})`);
});
