# Telephony

[![CI](https://github.com/arnavranjan005/Telephony/actions/workflows/ci.yml/badge.svg)](https://github.com/arnavranjan005/Telephony/actions/workflows/ci.yml)

AI voice calling platform: outbound/inbound calls via Telnyx, appointment
booking via Google Calendar, a provider-agnostic AI agent with tool calling
(Google Gemini by default), automated outbound campaigns and callback
follow-ups, TCPA/DNC compliance, Prisma on Neon Postgres, a REST API, and
Server-Sent Events for live call updates.

This is a foundation to build on, not the full feature set described in the
requirements doc (no analytics dashboard or live bidirectional audio
streaming yet — see "Not yet implemented" below).

## Stack

- Express + TypeScript
- Prisma ORM → Neon (serverless Postgres)
- Telnyx Call Control API (outbound calls, inbound webhooks, TTS, transcription)
- Google Calendar API (OAuth2) for availability checks and booking
- AI agent abstraction layer (`src/lib/ai`) with a Google Gemini implementation
- Server-Sent Events for streaming call/conversation events to clients
- BullMQ on Redis (Aiven) — distributed job queue driving campaign and follow-up dialing, with a
  separate horizontally-scalable worker process
- Global DNC (Do-Not-Call) list enforced on every outbound-dialing path

## Project layout

```
src/
  config/        env loading (zod-validated), Prisma client singleton, Redis connection options
  lib/ai/        provider-agnostic AIAgent interface, tool definitions, Google implementation
  lib/telnyx/    Telnyx client, call control actions, webhook signature verification
  lib/google-calendar/  OAuth client + calendar availability/booking service
  lib/compliance/  DNC list service (isNumberOnDnc/addToDnc/removeFromDnc/listDnc)
  controllers/   request handlers
  routes/        Express routers
  services/      call ↔ AI agent orchestration, outbound dialing, campaigns, follow-ups
  queues/        BullMQ queue definitions + startup reconciliation sweep
  sse/           in-process event bus + SSE endpoint handler
  middleware/    error handling
  server.ts      API process entry point
  worker.ts      dial-queue worker process entry point (run separately, scales horizontally)
prisma/schema.prisma  Lead, Call, Appointment, ConversationMessage, Campaign,
                      CampaignContact, FollowUp, DncEntry models
```

## AI agent abstraction layer

`src/lib/ai/types.ts` defines an `AIAgent` interface (`generateReply(messages, tools, systemPrompt)`)
that is independent of any vendor SDK. `src/lib/ai/providers/googleAgent.ts` implements it using
`@google/genai` (Gemini) with function calling. `src/lib/ai/agentFactory.ts` picks the implementation
based on `AI_PROVIDER`. To add another provider (OpenAI, Anthropic, etc.), implement `AIAgent` in a
new file under `providers/` and add a case in `agentFactory.ts` — nothing else in the app changes.

Tools are declared as plain objects (`ToolDefinition`: name, description, JSON-schema-like
parameters, and a handler function) in `src/lib/ai/tools/`, so they're also provider-agnostic.
`src/lib/ai/conversationRunner.ts` drives the loop: call the agent, execute any requested tool
calls, feed results back, repeat until the agent returns a final spoken reply.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in:
   - `DATABASE_URL` — your Neon Postgres connection string
   - `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_FROM_NUMBER` — from the Telnyx portal
   - `TELNYX_PUBLIC_KEY` — for webhook signature verification (optional but recommended)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — OAuth client for Calendar
   - `GOOGLE_AI_API_KEY` — Gemini API key (https://aistudio.google.com/apikey)
3. `npm run prisma:generate`
4. `npm run prisma:migrate` — creates the schema on your Neon database
5. `npm run dev` — starts the server with hot reload on `PORT` (default 3000)

### Connecting Google Calendar

1. Start the server, then `GET /api/calendar/oauth/url` to get a consent URL; open it and authorize.
2. Google redirects to `GOOGLE_REDIRECT_URI` (`/api/calendar/oauth/callback`), which returns a
   `refresh_token`. Save that as `GOOGLE_REFRESH_TOKEN` in `.env` and restart the server.

### Connecting Telnyx webhooks

Point your Telnyx Call Control application's webhook URL at
`https://<your-deployment>/api/calls/webhook`. In local dev, use a tunnel (e.g. `ngrok http 3000`)
and set that URL in the Telnyx portal.

## API overview

- `POST /api/calls/outbound` `{ toNumber, leadId? }` — place an outbound call
- `GET /api/calls` / `GET /api/calls/:callId` — list/inspect calls (includes conversation history)
- `GET /api/calls/:callId/events` — SSE stream of call status + AI conversation turns
- `POST /api/calls/webhook` — Telnyx webhook receiver (call.initiated/answered/transcription/hangup)
- `POST /api/leads`, `GET /api/leads`, `GET /api/leads/:leadId`, `PATCH /api/leads/:leadId`, `DELETE /api/leads/:leadId`
- `GET /api/calendar/busy?timeMin=&timeMax=` — free/busy lookup
- `POST /api/calendar/appointments` `{ title, startTime, endTime, leadId?, callId?, attendeeEmail? }` — book directly via REST
- `GET /api/appointments`, `GET /api/appointments/:id`, `POST /api/appointments/:id/cancel`
- `POST /api/campaigns` `{ name, script?, contacts: [{ leadId? | phoneNumber, firstName?, lastName? }] }` — create a campaign (upserts leads from phone numbers)
- `GET /api/campaigns`, `GET /api/campaigns/:id`, `POST /api/campaigns/:id/start`, `POST /api/campaigns/:id/pause` — the scheduler dials `PENDING` contacts of any `RUNNING` campaign automatically and marks it `COMPLETED` once none are left
- `POST /api/followups` `{ leadId, scheduledAt, reason? }` — schedule a callback; the scheduler dials it automatically once due
- `GET /api/followups`, `POST /api/followups/:id/cancel`
- `GET /api/dnc`, `POST /api/dnc` `{ phoneNumber, reason? }`, `DELETE /api/dnc/:phoneNumber` — global Do-Not-Call list; every outbound dial (manual, campaign, or follow-up) is checked against it first

### Consuming the SSE stream

```js
const source = new EventSource(`/api/calls/${callId}/events`);
source.addEventListener("conversation.message", (e) => console.log(JSON.parse(e.data)));
```

## How a live call flows

1. Inbound call → `call.initiated` webhook creates a `Call` row and answers it; outbound calls are
   created via `POST /api/calls/outbound`. For inbound calls, the caller's phone number is looked up
   (or a new `Lead` is created) via an upsert on `Lead.phoneNumber` and linked to the `Call` — so a
   returning caller is recognized as the same lead, and a first-time caller is tracked automatically
   without anyone having to create a lead for them first.
2. `call.answered` → starts Telnyx transcription and speaks a greeting.
3. `call.transcription` (final transcript) → `handleCallerUtterance` persists the utterance, runs
   the AI agent with calendar/lead tools attached, persists the resulting turns, publishes them to
   the SSE bus, and speaks the final reply back on the call.
4. `call.hangup` → records the outcome. If the call had reached `call.answered` (a real conversation
   happened), it's `COMPLETED` regardless of hangup cause. Otherwise Telnyx's `hangup_cause` is mapped
   to `BUSY` / `NO_ANSWER` / `CANCELED` / `FAILED` and stored on `Call.outcome`, so unanswered dials
   are distinguishable from completed ones instead of everything being marked `COMPLETED`.

If the call belongs to a campaign contact, the campaign's `script` is appended to the AI agent's
system prompt for that call. The agent also has `add_to_dnc` (adds the caller to the DNC list the
moment they ask to stop being contacted) and `schedule_followup` (books an automatic callback)
tools available on every call, alongside the calendar and lead tools.

## Automated dialing (campaigns & follow-ups) — distributed via BullMQ

Dialing is driven by a BullMQ queue (`src/queues/dialQueue.ts`, one queue named `dial`) backed by
Redis, consumed by a **separate worker process** (`src/worker.ts`) rather than the API process. This
is what makes it a real distributed system: run as many worker instances as you want (e.g. scaled up
during a campaign push), and none of them will double-dial the same row.

- **Producers**: `followUpService.createFollowUp` enqueues a delayed job (`delay = scheduledAt - now`);
  `campaignService.startCampaign` enqueues one job per `PENDING` contact immediately. Every job uses a
  **deterministic BullMQ job ID** (`followup:<id>` / `campaign-contact:<id>`), so re-enqueueing the
  same row (e.g. from the reconciliation sweep below) is a no-op instead of a duplicate job.
- **Consumer**: `src/worker.ts` runs a BullMQ `Worker` with a rate limiter
  (`DIAL_RATE_LIMIT_MAX` jobs per `DIAL_RATE_LIMIT_DURATION_MS`, default 5/sec) so Telnyx never gets
  bursted regardless of how many jobs land at once.
- **Distributed consistency**: BullMQ's own per-job lock already stops two workers from processing the
  same job concurrently, but the authoritative guard is a **database compare-and-swap** in
  `followUpService.processFollowUpJob` / `campaignService.processCampaignContactJob` — an atomic
  `updateMany({ where: { id, status: "PENDING" }, data: { status: "CALLING" } })`. Postgres row
  locking guarantees only one caller ever sees `count === 1` for a given row, so even a job retried
  after a worker crash, or a row re-enqueued by the reconciliation sweep, can never be dialed twice.
- **Reconciliation**: on startup, `src/worker.ts` calls `reconcilePendingWork()`
  (`src/queues/reconciliation.ts`), which re-enqueues every DB row still `PENDING` — safe because of
  the deterministic job IDs above. This self-heals if Redis was flushed/evicted (a real possibility on
  Aiven's free tier) or if rows were created while no worker was running; the database is the source
  of truth, the queue is derived from it.
- Both job types dial through `src/services/outboundDialService.ts`, the same path used by the manual
  `POST /api/calls/outbound` endpoint — every outbound call, however it originates, checks the DNC
  list first and is skipped (marked `SKIPPED_DNC`) if the number is listed.

Run `npm run worker` (or `npm run start:worker` in prod) as its own process alongside `npm run dev`/
`npm start` — the API and the dial worker are independently deployable and scalable.

### Redis setup (Aiven free tier)

1. Create a free Redis service on Aiven and copy its `rediss://` connection URI (includes
   credentials; TLS is required on Aiven, and `rediss://` enables it automatically).
2. Set `REDIS_URL` in `.env` to that URI.
3. If you ever hit TLS certificate verification errors against a self-managed/non-standard CA, set
   `REDIS_TLS_REJECT_UNAUTHORIZED=false` as an escape hatch — leave it `true` (default) otherwise.

## Atomicity & consistency notes

Most endpoints are a single Prisma write, which Postgres already makes atomic. The paths that combine
multiple writes, or an external call plus a DB write, get explicit handling:

- **`campaignService.createCampaign`** wraps the lead-upsert + contact-create loop in
  `prisma.$transaction` — a campaign is created with either all of its contacts or none.
- **`calendarController.bookAppointment`** creates the Google Calendar event, then the `Appointment`
  row; if the DB write fails, it compensates by deleting the just-created Google event rather than
  leaving an orphaned booking the app has no record of.
- **Campaign completion** (`processCampaignContactJob`) and the **PENDING → CALLING claim** on both
  `FollowUp` and `CampaignContact` are both conditional `updateMany` calls, so concurrent callers
  never conflict — see the distributed-dialing section above.
- **`DELETE /api/leads/:leadId`** uses `deleteMany` (not `delete`), and **`POST /api/appointments/:id/cancel`**
  short-circuits if the appointment is already `CANCELED` — repeating either call on an
  already-completed resource returns the same success response instead of a 404/500 on the retry.

## Idempotency (client-retry safety)

Endpoints that place a real call, book a calendar slot, or create a campaign/follow-up are **not**
naturally safe to retry — a client that times out and retries would place a second phone call, double
book a slot, or schedule a duplicate follow-up. These support an opt-in `Idempotency-Key` header
(Stripe-style), implemented in `src/middleware/idempotency.ts` and applied to:

`POST /api/calls/outbound`, `POST /api/leads`, `POST /api/followups`, `POST /api/campaigns`,
`POST /api/calendar/appointments`

Send the same `Idempotency-Key: <client-generated-uuid>` header on a retry and you get the *original*
response replayed instead of the operation running again:

- The key is claimed via an atomic unique-constraint insert (`IdempotencyKey.key`), so two concurrent
  requests with the same key can't both proceed — the loser gets `409`.
- A successful (`< 500`) response is cached against the key and replayed verbatim on repeat requests.
- Reusing a key with a *different* request body returns `422` — otherwise a client bug (reusing a key
  across unrelated requests) would silently return the wrong cached response.
- A `>= 500` response releases the key instead of caching it, so a transient failure (e.g. Telnyx
  briefly down) doesn't permanently lock a client out of ever successfully retrying that key.
- No header, no behavior change — existing callers are unaffected.

Endpoints that are already naturally idempotent (`GET`s, `PATCH /api/leads/:leadId`, `POST /api/dnc`
which upserts, `DELETE /api/dnc/:phoneNumber`, campaign `start`/`pause` which just flip a status flag)
don't need this and don't have it applied. There's no cleanup job for old `IdempotencyKey` rows yet —
fine at this scale, but worth a TTL sweep if this sees real traffic.

## Not yet implemented

The full requirements doc describes a much larger system. This scaffold intentionally leaves out:
sentiment analysis (detecting caller sentiment mid-call to trigger retention logic), an analytics
dashboard (call/campaign/conversion metrics), and live bidirectional audio streaming (current
inbound/outbound conversation flow uses Telnyx's transcription + TTS webhooks rather than raw media
streaming, and voice is whatever Telnyx's TTS provides — no custom paralinguistic fillers/pacing).
These fit into the same architecture — new routes/services/tools — and are natural next increments.

## Scripts

- `npm run dev` — dev server with hot reload
- `npm run build` / `npm start` — compile and run
- `npm run typecheck` — TypeScript check only
- `npm run prisma:studio` — browse the database
