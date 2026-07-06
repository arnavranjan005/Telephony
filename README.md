# Telephony

[![CI](https://github.com/arnavranjan005/Telephony/actions/workflows/ci.yml/badge.svg)](https://github.com/arnavranjan005/Telephony/actions/workflows/ci.yml)

AI voice calling platform: outbound/inbound calls via Telnyx, appointment
booking via Google Calendar, a provider-agnostic AI agent with tool calling
(Google Gemini by default), automated outbound campaigns and callback
follow-ups, TCPA/DNC compliance, real-time bidirectional media streaming with
mid-sentence barge-in as the default calling path, a distributed BullMQ dial
worker, Prisma on Neon Postgres, a REST API, Server-Sent Events for live call
updates, and a Next.js admin panel.

This is a foundation to build on, not the full feature set described in the
requirements doc (no sentiment logic yet — see "Not yet implemented" below).

## Monorepo layout (Nx)

This is an Nx monorepo (npm workspaces under the hood — deliberately no
`@nx/next`/`@nx/node` plugins, just `nx:run-commands` wired to each project's
own `package.json` scripts, to keep the dependency footprint small):

```
apps/
  api/      Express HTTP server
  worker/   BullMQ dial-job consumer - separate, horizontally-scalable process
  web/      Next.js admin panel - static export, client-only, talks to apps/api over HTTP
packages/
  config/        zod-validated env loading (single source for every app)
  database/      prisma/schema.prisma + generated client + the prisma singleton
  queue/         Redis connection options, the BullMQ dial queue + job types, reconciliation sweep
  domain/        services shared by api & worker: outbound dialing, campaigns, follow-ups, DNC, Telnyx call control
  shared-types/  DTOs/Zod schemas for REST payloads, shared by apps/api and apps/web
```

`apps/api` and `apps/worker` are two independent Node processes that share
`packages/*` - deploy them separately (or together) and scale the worker
independently of the API. `apps/web` never runs any Next.js server-side code
(see the "Admin panel" section) - it's a static site that calls `apps/api`
over HTTP, same as any other client.

Run things with Nx from the repo root:

```
npx nx run-many -t build --all       # build every project (same as `npm run build`)
npx nx run-many -t typecheck --all   # same as `npm run typecheck`
npx nx run-many -t test --all        # same as `npm test`
npx nx run api:dev                   # same as `npm run dev:api`
npx nx run worker:dev                # same as `npm run dev:worker`
npx nx run web:dev                   # same as `npm run dev:web`
```

Nx infers the dependency graph from each package's `package.json`
`dependencies` (e.g. `apps/api` depends on `@telephony/domain`, which depends
on `@telephony/database` and `@telephony/queue`), so `nx run-many -t build`
always builds `packages/database` (which generates the Prisma client first)
before anything that imports it.

## AI agent abstraction layer

`apps/api/src/ai/types.ts` defines an `AIAgent` interface
(`generateReply(messages, tools, systemPrompt)`) that is independent of any
vendor SDK. `apps/api/src/ai/providers/googleAgent.ts` implements it using
`@google/genai` (Gemini) with function calling. `apps/api/src/ai/agentFactory.ts`
picks the implementation based on `AI_PROVIDER`. To add another provider
(OpenAI, Anthropic, etc.), implement `AIAgent` in a new file under
`providers/` and add a case in `agentFactory.ts` — nothing else in the app
changes.

Tools are declared as plain objects (`ToolDefinition`: name, description,
JSON-schema-like parameters, and a handler function) in `apps/api/src/ai/tools/`,
so they're also provider-agnostic. `apps/api/src/ai/conversationRunner.ts`
drives the loop: call the agent, execute any requested tool calls, feed
results back, repeat until the agent returns a final spoken reply.

## Setup

1. `npm install` (installs and links every app/package via npm workspaces)
2. `cp .env.example .env` at the repo root and fill in:
   - `DATABASE_URL` — your Neon Postgres connection string
   - `REDIS_URL` — an Aiven (or other) Redis `rediss://` connection string (see below)
   - `TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_FROM_NUMBER` — from the Telnyx portal
   - `TELNYX_PUBLIC_KEY` — for webhook signature verification (optional but recommended)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — OAuth client for Calendar
   - `GOOGLE_AI_API_KEY` — Gemini API key (https://aistudio.google.com/apikey)
   - `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` — required because real-time media
     streaming (barge-in) is the default calling path (`MEDIA_STREAM_ENABLED=true` by default); set
     `MEDIA_STREAM_ENABLED=false` instead if you'd rather run the legacy webhook-based flow and skip these
3. `npx nx run database:prisma-generate`
4. `npx nx run database:prisma-migrate` — creates the schema on your Neon database
5. `npm run dev:api` — starts the API with hot reload on `PORT` (default 3000)
6. `npm run dev:worker` — starts the dial worker, in a separate terminal
7. `cp apps/web/.env.local.example apps/web/.env.local`, then `npm run dev:web` — starts the admin panel on `:3001` (Next's default when 3000 is taken)

### Connecting Google Calendar

1. With the API running, `GET /api/calendar/oauth/url` to get a consent URL; open it and authorize.
2. Google redirects to `GOOGLE_REDIRECT_URI` (`/api/calendar/oauth/callback`), which returns a
   `refresh_token`. Save that as `GOOGLE_REFRESH_TOKEN` in `.env` and restart the API.

### Connecting Telnyx webhooks

Point your Telnyx Call Control application's webhook URL at
`https://<your-deployment>/api/calls/webhook`. In local dev, use a tunnel (e.g. `ngrok http 3000`)
and set that URL in the Telnyx portal.

## API overview

- `POST /api/calls/outbound` `{ toNumber, leadId?, streaming? }` — place an outbound call; streams (barge-in) by default, pass `streaming: false` to opt out and use the legacy webhook flow instead (either way, gated by the global `MEDIA_STREAM_ENABLED` flag)
- `GET /api/calls` / `GET /api/calls/:callId` — list/inspect calls (includes conversation history)
- `GET /api/calls/:callId/events` — SSE stream of call status + AI conversation turns
- `POST /api/calls/webhook` — Telnyx webhook receiver (call.initiated/answered/transcription/hangup)
- `POST /api/leads`, `GET /api/leads`, `GET /api/leads/:leadId`, `PATCH /api/leads/:leadId`, `DELETE /api/leads/:leadId`
- `POST /api/leads/:leadId/consent` `{ granted, source? }` — record or revoke TCPA consent for a lead; `consentedAt` is always set server-side
- `GET /api/calendar/busy?timeMin=&timeMax=` — free/busy lookup
- `POST /api/calendar/appointments` `{ title, startTime, endTime, leadId?, callId?, attendeeEmail? }` — book directly via REST
- `GET /api/appointments`, `GET /api/appointments/:id`, `POST /api/appointments/:id/cancel`
- `POST /api/campaigns` `{ name, script?, objectionPlaybook?, contacts: [{ leadId? | phoneNumber, firstName?, lastName? }] }` — create a campaign (upserts leads from phone numbers); `objectionPlaybook` is optional campaign-specific rebuttal guidance layered on top of the baseline objection-handling instruction every call already gets (see below)
- `GET /api/campaigns`, `GET /api/campaigns/:id`, `POST /api/campaigns/:id/start`, `POST /api/campaigns/:id/pause` — the dial worker processes `PENDING` contacts of any `RUNNING` campaign automatically and marks it `COMPLETED` once none are left
- `GET /api/campaigns/objection-baseline` — returns the baseline objection-handling instruction text every call gets by default (`OBJECTION_HANDLING_BASELINE`, `apps/api/src/callConversationService.ts`); used to display it in the admin panel's "New campaign" form so whoever writes `objectionPlaybook` can see what's already covered
- `POST /api/followups` `{ leadId, scheduledAt, reason? }` — schedule a callback; the dial worker dials it automatically once due
- `GET /api/followups`, `POST /api/followups/:id/cancel`
- `GET /api/dnc`, `POST /api/dnc` `{ phoneNumber, reason? }`, `DELETE /api/dnc/:phoneNumber` — global Do-Not-Call list; every outbound dial (manual, campaign, or follow-up) is checked against it first
- `GET /api/analytics/overview` — lead/call/appointment/campaign/follow-up/DNC counts + the call-to-appointment rate
- `GET /api/analytics/campaigns` — per-campaign contact-status breakdown + appointments booked
- `GET /api/analytics/timeseries?days=14` — daily call-outcome counts for charting
- `GET /api/events/stream` — dashboard-wide SSE feed: every call/lead/campaign/appointment/follow-up/DNC lifecycle event, not scoped to one call

### Consuming the SSE stream

```js
// Per-call: status + AI conversation turns for one call
const callEvents = new EventSource(`/api/calls/${callId}/events`);
callEvents.addEventListener("conversation.message", (e) => console.log(JSON.parse(e.data)));

// Dashboard-wide: every event across every call/lead/campaign/appointment/follow-up/DNC change
const dashboardEvents = new EventSource(`/api/events/stream`);
dashboardEvents.addEventListener("lead.updated", (e) => console.log(JSON.parse(e.data)));
```

## Admin panel (`apps/web`)

A Next.js app configured with `output: "export"` in `next.config.js` — this
is what actually guarantees there's no Next.js server at runtime: the build
fails hard if anything tries to use API routes, middleware, or server
actions. Every page is a client component; all data fetching happens in the
browser via `apps/web/src/lib/apiClient.ts`, which calls `apps/api` at
`NEXT_PUBLIC_API_URL` with plain `fetch`. `npx nx run web:build` produces a
static `apps/web/out/` directory you can serve from any static host/CDN —
it never needs a Node process of its own in production.

Built with shadcn/ui + Tailwind v4 (`npx shadcn@latest add ...`), typed
against `@telephony/shared-types` throughout. Pages: a live-updating
**Dashboard** (stat cards, a 14-day call-volume chart, a campaign-performance
table, live call monitoring, and a live activity feed), **Calls** (log +
transcript detail), **Leads** (list + status/consent/notes editing),
**Campaigns** (create, list, start/pause, per-campaign contact/performance
detail, plus an optional objection-playbook field on the create form - which
auto-displays the baseline objection-handling text every call already gets,
fetched from `GET /api/campaigns/objection-baseline`, so it's clear what's
already covered before adding campaign-specific detail), **Appointments**
(list view and a calendar view), **Follow-ups**,
and the **Do-Not-Call** list — each with cancel/create actions wired straight
to the REST API.

Live updates come from a dashboard-wide SSE feed (`GET /api/events/stream`,
`apps/api/src/sse/sseHandler.ts`'s `streamAllEvents`, consumed via
`apps/web/src/hooks/useEventStream.ts`) that broadcasts every call/lead/
campaign/appointment/follow-up/DNC lifecycle event over the same `EventEmitter`
bus the per-call stream uses — the dashboard's stat cards, tables, and
activity feed all refetch/update as events arrive, with no polling.

**Live call monitoring** (`apps/web/src/components/live-calls-panel.tsx`)
lists every call currently `IN_PROGRESS` on the dashboard; expanding one
mounts `LiveCallTranscript`, which subscribes to that call's own
`GET /api/calls/:callId/events` SSE feed and renders each conversation turn
the instant `callConversationService`/`callStreamSession` publish it — no
polling, no refetch.

**Appointments calendar view** (`apps/web/src/app/appointments/page.tsx`) adds
a calendar tab (shadcn `Calendar`) alongside the flat list, grouping bookings
by local-calendar-day so you can see a month at a glance instead of only a
chronological list.

Analytics themselves are computed server-side in
`packages/domain/src/analyticsService.ts` (`getOverviewStats`,
`getCampaignPerformance`, `getCallTimeseries`) and exposed at
`/api/analytics/{overview,campaigns,timeseries}`.

### Build gotcha: don't let `NODE_ENV` leak into `next build`

`apps/web`'s `build` script pins `NODE_ENV=production` explicitly
(`apps/web/project.json`'s Nx target also sets it) because Nx's
`nx:run-commands` executor otherwise propagates whatever `NODE_ENV` happens to
be set in the invoking shell into the `next build` child process. If that's
`development` (or anything other than `production`/unset), `next build` mixes
its dev and prod runtime chunks during static-page generation and every route
fails to prerender with `TypeError: Cannot read properties of null (reading
'useContext')`. Building via `npx next build` directly is unaffected since Next
defaults `NODE_ENV` itself when it isn't already set — the bug only shows up
through an orchestrator (Nx, and potentially others) that forwards an existing
`NODE_ENV` value into the build.

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

`schedule_followup` validates the caller's requested time against the calling-hours window (see
below) *before* writing anything: a request outside 8am-9pm local to the caller's number schedules
nothing and returns a suggested in-window time instead, so the agent can negotiate a real time with
the caller in conversation ("I can only call between 8am and 9pm - does 8:30am tomorrow work?")
rather than silently booking a promise that the dial-time calling-hours gate would later break
without telling anyone.

**Undoing a mutating tool call mid-conversation**: `cancel_appointment` and `cancel_followup` let
the agent actually act on the system prompt's "cancel or adjust an earlier action" instruction
(a caller changing their mind about a booking they just made) instead of that instruction having
no tool behind it. Neither requires the id up front - if the agent doesn't already have it from an
earlier tool result in the same conversation, `findCancelableAppointmentId`/`findCancelableFollowUpId`
(`apps/api/src/appointmentService.ts`, `packages/domain/src/followUpService.ts`) look up the most
recent cancelable row for the lead, preferring one tied to the current call. Both cancellations are
a compare-and-swap `updateMany` gated on the row still being in a cancelable status (mirroring the
`PENDING -> CALLING` dial-claim pattern below), so a cancel racing a concurrent dial-claim, a REST
cancel, or a repeated tool call can't corrupt either side - exactly one caller wins, repeating a
cancel on an already-canceled row is a no-op success, and canceling something already in progress
(`CALLING`) or resolved (`COMPLETED`/`FAILED`) is reported back as not-cancelable rather than forced.
`cancelAppointmentById` additionally reverts its claim if the Google Calendar delete call fails, so a
transient Google error can't leave an appointment marked canceled locally while still live on the
real calendar.

## Real-time media streaming (barge-in) — the default calling path, `apps/api/src/media-stream/`

The alternative to this is a turn-based flow: Telnyx transcribes a full utterance, then the AI's
whole reply is sent to `calls.speak` — there's no way to know a caller started talking again while
the AI is still speaking, so it can't stop mid-sentence. `MEDIA_STREAM_ENABLED` (on by default) puts
every call on an alternate path built on Telnyx's bidirectional Media Streaming API (raw audio over a
WebSocket instead of transcribe-then-speak webhooks) that supports genuine mid-sentence interruption.
The legacy webhook-based flow still exists as a parallel path for anyone who opts out - see below.

- **Opting out**: set `MEDIA_STREAM_ENABLED=false` to turn streaming off globally and fall back to
  the legacy webhook flow for every call (inbound and outbound). Per-call, the manual
  `POST /api/calls/outbound` endpoint accepts `{ "streaming": false }` to opt just that call out
  (a per-request `true` can't turn the feature back on if the global flag is off). Campaigns
  (`POST /api/campaigns` `{ streamingEnabled: false }`) and follow-ups (`POST /api/followups`
  `{ streamingEnabled: false }`) can likewise opt their automated dials out - `processCampaignContactJob`/
  `processFollowUpJob` thread the row's flag through to `placeOutboundCall`, still gated by the global
  flag at actual dial time. A follow-up booked mid-conversation via the `schedule_followup` tool
  inherits the current call's streaming setting automatically.
- **`apps/api/src/media-stream/mediaStreamServer.ts`** — a `ws` WebSocket server attached to the
  existing Express `http.Server` (not a separate app/process - it needs the same Prisma client, tool
  builders, and AI agent config `apps/api` already loads). Telnyx connects here once per streaming
  call; the connection is gated by a short-lived, single-use token embedded in the `stream_url` query
  string (`packages/domain/src/mediaStream/streamAuth.ts`), since this is the first genuinely public,
  unauthenticated-by-default inbound endpoint in the app.
- **`callStreamSession.ts`** owns a small state machine per call: `IDLE → LISTENING → THINKING →
  SPEAKING`, with barge-in able to interrupt `THINKING`/`SPEAKING` back to `LISTENING` at any point.
  Caller audio is forwarded to Deepgram's streaming STT (`deepgramClient.ts`); Deepgram's `is_final`
  segments accumulate into the current utterance, `speech_final`/`UtteranceEnd` signals the caller is
  done talking (the real turn-end trigger — a long utterance can span several `is_final` segments
  without actually being finished), and *any* transcript activity while `THINKING`/`SPEAKING` is
  treated as a barge-in.
- **Barge-in mechanics**: a monotonic `turnVersion` counter is the authoritative "is this stale"
  check everywhere (not an `AbortSignal` - per `@google/genai`'s own docs, aborting a Gemini call
  doesn't stop server-side generation or billing, only wasted local waiting). On barge-in: bump
  `turnVersion`, send Telnyx `{"event":"clear"}` **before** touching local TTS state (stale audio is
  already buffered on Telnyx's side regardless of what happens locally), then return to `LISTENING`.
- **What never gets rolled back**: a tool call (`book_appointment`, `add_to_dnc`, etc.) that's already
  mid-execution when a barge-in lands is never aborted - it always runs to completion and its result
  is always persisted (flagged `ConversationMessage.interrupted: true` if the turn was abandoned
  before producing a spoken reply). These handlers wrap non-idempotent external calls (a Calendar API
  insert, a DB write) with no partial-cancel semantics; forcibly abandoning one mid-flight would let a
  real side effect happen while the app never records it. Correcting an already-completed action the
  caller changed their mind about (e.g. "actually, make it 3pm instead") is handled the same way a
  human assistant would - the system prompt instructs the agent to check for and cancel/adjust a
  prior action on the next turn, not by any cancellation plumbing.
- **`toolLock` serializes tool execution per call** (`streamingConversationRunner.ts`'s
  `runExclusive`, gated inside `callStreamSession.ts`): guarantees at most one tool handler runs at a
  time, so an old superseded turn's tool call can never race a new turn's tool call. Without this, two
  competing tool calls (e.g. two `book_appointment`s) could both succeed and conflict, and - since the
  LLM has no innate sense of timing, only message order - a late-arriving result could be read as more
  recent than it actually was. The lock only gates the tool-handler invocation itself; barge-in, STT,
  and the next turn's own LLM call are unaffected and stay instant.
- **TTS**: streaming synthesis via ElevenLabs' `/stream` endpoint (`ttsSender.ts`) - the response body
  is consumed as a stream of PCM chunks as ElevenLabs synthesizes them and paced out over the WebSocket
  in ~20ms frames as bytes arrive, so playback can start before the full reply has finished
  synthesizing, instead of waiting for one complete buffer. `cancel()` aborts the in-flight HTTP
  request itself (via `AbortSignal`), not just local playback, so a barge-in stops paying for/
  downloading audio nobody will hear. The remaining gap: the full reply text still has to be sent to
  ElevenLabs in one request up front - there's no token-by-token LLM output streaming feeding this
  incrementally, so a streaming LLM → streaming TTS pipeline end-to-end is the natural next step.
- **Persistence changes shape**: unlike the webhook path's single end-of-turn batch write, a
  streaming turn persists incrementally (the user utterance the instant it's finalized, each
  tool-call/tool-result message as it actually happens, the final reply only if not superseded) -
  there's no single "end of turn" instant to batch at once a turn can be abandoned mid-way.
- **New env vars**: `MEDIA_STREAM_ENABLED`, `MEDIA_STREAM_WS_PATH`, `MEDIA_STREAM_SAMPLE_RATE`,
  `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (see `.env.example`).

## Automated dialing (campaigns & follow-ups) — distributed via BullMQ

Dialing is driven by a BullMQ queue (`packages/queue/src/dialQueue.ts`, one queue named `dial`)
backed by Redis, consumed by `apps/worker` — a process entirely separate from `apps/api`. This is
what makes it a real distributed system: run as many worker instances as you want (e.g. scaled up
during a campaign push), and none of them will double-dial the same row.

- **Producers**: `followUpService.createFollowUp` (in `packages/domain`) enqueues a delayed job
  (`delay = scheduledAt - now`); `campaignService.startCampaign` enqueues one job per `PENDING`
  contact immediately. Every job uses a **deterministic BullMQ job ID** (`followup-<id>` /
  `campaign-contact-<id>`), so re-enqueueing the same row (e.g. from the reconciliation sweep below)
  is a no-op instead of a duplicate job.
- **Consumer**: `apps/worker/src/worker.ts` runs a BullMQ `Worker` with a rate limiter
  (`DIAL_RATE_LIMIT_MAX` jobs per `DIAL_RATE_LIMIT_DURATION_MS`, default 5/sec) so Telnyx never gets
  bursted regardless of how many jobs land at once.
- **Distributed consistency**: BullMQ's own per-job lock already stops two workers from processing the
  same job concurrently, but the authoritative guard is a **database compare-and-swap** in
  `followUpService.processFollowUpJob` / `campaignService.processCampaignContactJob` (both in
  `packages/domain`) — an atomic `updateMany({ where: { id, status: "PENDING" }, data: { status:
  "CALLING" } })`. Postgres row locking guarantees only one caller ever sees `count === 1` for a given
  row, so even a job retried after a worker crash, or a row re-enqueued by the reconciliation sweep,
  can never be dialed twice.
- **Reconciliation**: on startup, `apps/worker` calls `reconcilePendingWork()`
  (`packages/queue/src/reconciliation.ts`), which re-enqueues every DB row still `PENDING` — safe
  because of the deterministic job IDs above. This self-heals if Redis was flushed/evicted (a real
  possibility on Aiven's free tier) or if rows were created while no worker was running; the database
  is the source of truth, the queue is derived from it.
- Both job types dial through `packages/domain/src/outboundDialService.ts`, the same path used by
  the manual `POST /api/calls/outbound` endpoint — every outbound call, however it originates, checks
  the DNC list first and is skipped (marked `SKIPPED_DNC`) if the number is listed. Campaign and
  follow-up dispatch additionally require lead consent and a legal calling-hours window - see below.

`apps/api` and `apps/worker` are independently deployable and scalable — run `npm run dev:api` and
`npm run dev:worker` as separate processes (locally, that's two terminals; in production, two
separate deployments pointed at the same Postgres and Redis).

## TCPA compliance: consent and calling hours

Beyond the DNC list (opt-out, number-scoped), two more TCPA-relevant checks gate every **automated**
outbound dial (campaign dispatch and follow-up dispatch — not the manual `POST /api/calls/outbound`
endpoint, which a human explicitly triggers per call):

- **Consent** (`packages/domain/src/consentService.ts`) — opt-in, lead-scoped. Every `Lead` has a
  `consentStatus` (`UNKNOWN` by default, `GRANTED`, or `REVOKED`), a `consentSource`, and a
  `consentedAt` timestamp. `POST /api/leads/:leadId/consent` `{ granted, source? }` records or revokes
  it — `consentedAt` is always set server-side at the moment it changes, not from client input, so it's
  a reliable audit trail. `outboundDialService.placeOutboundCall` takes a `requireConsent` option;
  `campaignService`/`followUpService` pass it, so a lead without `GRANTED` consent is skipped
  (`SKIPPED_NO_CONSENT`) instead of dialed.
- **Calling hours** (`packages/domain/src/compliance/callingHours.ts`) — 47 CFR 64.1200(a)(3): no
  calls before 8am or after 9pm in the *called number's* local time. The called number's area code is
  mapped to an IANA time zone via a built-in NANP table (`compliance/areaCodeTimezones.ts`); numbers
  with an unrecognized area code (including non-NANP/international numbers) have no determinable local
  time and are treated as unrestricted rather than blocked. Unlike DNC/consent, this is a *when* rather
  than a *whether*: `processCampaignContactJob`/`processFollowUpJob` check it before dialing, and if
  it's currently outside the window, give the row's claim back to `PENDING` and reschedule the dial for
  the next legal window (`nextCallingWindowStart`) instead of finalizing any terminal status.

Both checks are heuristics, not full compliance coverage — see "Not yet implemented" below for what's
still missing (National DNC Registry scrubbing, litigator-list scrubbing, per-number call-frequency
caps, state-specific rules).

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
(Stripe-style), implemented in `apps/api/src/middleware/idempotency.ts` and applied to:

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

The full requirements doc describes a much larger system. Live call monitoring and a Google Calendar
view for appointments (both previously listed here) are now implemented - see the "Admin panel"
section above. What's genuinely still missing:

- **Sentiment analysis / retention ("save") logic** - partially addressed: `record_sentiment`
  (`apps/api/src/ai/tools/sentimentTools.ts`) lets the agent log a tone/mood shift (positive/neutral/
  negative/very_negative) as it notices one during the call, and the tool result folds back into the
  same turn's conversation history so the agent's own next reply is already conditioned on it (e.g.
  softening tone after a negative reading) - no separate classifier call, no added latency. The
  system prompt instructs the agent to call it every time it notices a shift, not just once. What's
  still missing: this is discretionary (the agent decides when to call it, same as `update_lead_status`
  - there's no guaranteed-detection backstop independent of the LLM's own judgment), it isn't persisted
  anywhere beyond the conversation transcript (no `Call.sentiment` field, no dashboard surfacing), and
  it deliberately does **not** feed into `add_to_dnc` automatically - inferred mood alone shouldn't
  trigger an opt-out; `add_to_dnc`'s own trigger condition was separately widened to catch an
  *implicit* opt-out ("just leave me alone," not just "stop calling me"), which is the more accurate
  fix for that gap than wiring mood into it.
- **Objection handling** - partially addressed: `buildSystemPrompt` (`apps/api/src/callConversationService.ts`)
  gives every call a baseline instruction to acknowledge and honestly address objections (price, timing,
  "not interested," etc.) without inventing facts, and to weigh how hard to push a rebuttal against the
  caller's most recently recorded sentiment (drop it entirely if sentiment is `very_negative`). Campaigns
  can optionally layer a `Campaign.objectionPlaybook` field (same opt-in pattern as `script`, settable from
  the admin panel's "New campaign" form) with product-specific rebuttals - most campaigns won't need one,
  since the baseline covers generic objections. What's still missing: there's no scripted decision-tree/
  branching engine or dedicated objection-*detection* logic separate from the LLM's own judgment - it's
  layered system-prompt text, not an "agent-assist" style flow with structured branches.
- **Inbound call routing by intent** - every inbound call is answered and handled end-to-end by the
  same AI agent; there's no transfer/escalation to a human or routing to different
  departments/queues based on detected intent.
- **Paralinguistic voice realism** - partially addressed: `VERBAL_FILLER_GUIDANCE`
  (`apps/api/src/callConversationService.ts`, folded into `SYSTEM_PROMPT`) instructs the agent to
  occasionally write a natural filler ("um," "uh") or brief self-correction into its own reply text,
  the way a real person talks rather than reading a script - at most one per reply, and skipped
  entirely when stating something the caller needs to get right the first time (appointment times,
  phone numbers, prices). Since fillers are genuine spoken words, they're written into the same reply
  text that's both synthesized by TTS and persisted/displayed in the transcript - no separate markup,
  no code change beyond the prompt. What's still missing: breathing sounds and human-like pacing.
  ElevenLabs *does* support real SSML `<break time="x.xs" />` pause tags (confirmed via their docs -
  works on `eleven_flash_v2_5`, the model this app uses, gated behind `enable_ssml_parsing: true`;
  Eleven V3 is the exception that doesn't support them), but that's deliberately not implemented yet -
  the right design is code-level injection into a separate TTS-only copy of the text (based on
  punctuation), not the LLM writing raw tags into its own reply, since that reply string is also what
  gets persisted/shown in the transcript and a literal `<break time="0.3s" />` would look broken there.
  Actual breath-sound audio isn't available via SSML at all on this model - it's an Eleven v3-only
  proprietary bracket-tag feature (`[breathes]`, `[sighs]`), a different, still-experimental model from
  the one this app uses today.
- **Preferred tech stack (Siphon/Dograh) not used** - both are orchestration/self-hosting layers, not
  replacements for STT/TTS/LLM/telephony themselves (they let you bring your own provider, or swap to
  fully self-hosted open models, e.g. local Whisper/a local LLM/open TTS). This app already avoids the
  Vapi/n8n markup layer the client explicitly ruled out - it talks to Telnyx/Deepgram/ElevenLabs/Gemini
  directly, no platform fee stacked on top. What it's missing relative to Siphon/Dograh specifically:
  no provider abstraction/BYOK config to swap in cheaper or fully self-hosted models (Deepgram/
  ElevenLabs/Gemini are hardcoded, so there's no path to near-zero marginal cost the way a self-hosted
  Whisper/local-LLM/open-TTS stack would give), Dograh's visual workflow builder, and MCP-native tool
  calling. Telephony-carrier minutes (Telnyx or any equivalent) and LLM/STT/TTS usage are real,
  unavoidable costs regardless of which of these tools sits on top - no open-source layer removes them.

Real-time bidirectional media streaming with barge-in is now implemented and is the default calling
path (see the section above), and TTS synthesis itself now streams (ElevenLabs' `/stream` endpoint,
consumed chunk-by-chunk as audio is generated). Per-campaign/per-follow-up opt-out of streaming is
already supported (`streamingEnabled` on `Campaign`/`FollowUp`); "per-DID" granularity doesn't apply
yet since the app only supports a single `TELNYX_FROM_NUMBER` - no multi-number support. Still
missing: streaming/incremental LLM output (the full reply text is sent to ElevenLabs in one request,
so a fully streaming LLM → streaming TTS pipeline isn't there yet) and a multi-vendor STT/TTS
abstraction (Deepgram/ElevenLabs are hardcoded, not swappable). Both are natural next increments on
the same foundation.

TCPA compliance is partial (see the section above for what's covered - consent tracking and calling
hours). Still missing: National DNC Registry scrubbing (the FCC's registry, distinct from this app's
internal opt-out list, requires a paid SAN/API subscription), litigator-list scrubbing, per-number
call-frequency caps, an automatic retry/re-contact policy for busy/no-answer outcomes (today those are
just recorded, not re-queued), and state-specific "mini-TCPA" rules layered on top of the federal
baseline.

## Scripts (run from the repo root)

- `npm run dev:api` / `npm run dev:worker` / `npm run dev:web` — dev servers with hot reload
- `npm run build` — build every project (`nx run-many -t build --all`)
- `npm run typecheck` — TypeScript check every project
- `npm test` — run every project's test suite
- `npx nx run database:prisma-studio` — browse the database
- `npx nx graph` — visualize the project dependency graph

## End-to-end tests (`apps/e2e`)

Everything above (`npm test`) runs with Prisma, Redis, and Telnyx mocked — it checks each unit/route
in isolation. `apps/e2e` is different: each spec boots the real Express app (`createApp()`) against
**real** Postgres and Redis running in Docker, and drives them with real HTTP requests. Only the
third-party SDK each spec can't safely call for real is mocked, at the narrowest boundary the code's
architecture allows — everything else (Prisma, Express routing, the domain services, the tool-calling
loop) runs unmocked:

- `callLifecycle.e2e-test.ts` — mocks `telnyx`; boots a real in-process BullMQ `Worker`
  (`startWorker()`) alongside the app. The only place proving the atomic `PENDING -> CALLING` claim
  logic (used by `followUpService` and `campaignService` to avoid double-dialing when multiple workers
  race on the same row) actually holds under real Postgres row locking, not just a mocked Prisma client.
- `inboundCall.e2e-test.ts` — mocks `telnyx`; drives `POST /api/calls/webhook` through the
  `call.initiated -> call.answered -> call.hangup` lifecycle, proving the inbound-caller-to-Lead
  auto-linking and call-status mapping against real Postgres.
- `appointmentScheduling.e2e-test.ts` — mocks `googleapis`; drives the real `/api/calendar` and
  `/api/appointments` routes, proving availability checks, booking, cancellation, and the
  Idempotency-Key middleware against real Postgres.
- `aiConversation.e2e-test.ts` — mocks `telnyx` and `googleapis`, plus the `GoogleAgent` provider
  wrapper in place of `@google/genai` itself. That last substitution isn't a shortcut: `@google/genai`
  is ESM-only with a broken CJS `require` condition, so `googleAgent.ts` loads it via a
  Function-constructor dynamic `import()` specifically to dodge ts-jest's `import()` -> `require()`
  rewrite (see the comment there and in `googleAgent.test.ts`) — which also means Jest's CommonJS module
  registry can't intercept it with `jest.mock()` short of `--experimental-vm-modules`. Mocking one layer
  up, at the same provider-agnostic `AIAgent` seam the app already uses to be provider-swappable, is the
  tightest boundary available. The spec scripts multi-round tool-calling replies to drive a caller
  utterance through the real `conversationRunner` loop and the real calendar/compliance tool handlers,
  proving it lands in a real `Appointment` row (booking) or a real `DncEntry` row (opt-out), and that the
  final reply is actually spoken back over the (mocked) call.
- `calendarOAuth.e2e-test.ts` — mocks only `googleapis`'s `OAuth2` client; drives the real
  `/api/calendar/oauth/url` and `/oauth/callback` routes. No Postgres writes happen on this path, so
  there's no DB fixture cleanup in this spec.
- `sseCallEvents.e2e-test.ts` — mocks `telnyx`; opens a real TCP connection (supertest can't drive a
  streaming response, since it waits for the response to end, which SSE never does) to
  `GET /api/calls/:callId/events` and drives the real inbound webhook lifecycle, proving
  `call.answered`/`call.hangup` events published by `callController` arrive over the wire in real time,
  and that a connection only receives events for the call it subscribed to.
- `campaignAndFollowUpControls.e2e-test.ts` — mocks `telnyx`; boots a real in-process BullMQ `Worker`
  and proves three control-flow behaviors against real Postgres + Redis: canceling a follow-up before
  its delayed job fires actually prevents the dial (the job stays enqueued, but `processFollowUpJob`'s
  atomic PENDING-only claim turns it into a no-op); the dial rate limiter (`DIAL_RATE_LIMIT_MAX` per
  `DIAL_RATE_LIMIT_DURATION_MS`) genuinely throttles a burst of campaign contacts rather than dialing
  them all at once; and pausing a running campaign actually stops its still-queued contacts from being
  dialed — `processCampaignContactJob`'s atomic claim requires `campaign.status === RUNNING`, so
  contacts not yet claimed when the pause lands stay `PENDING` (a contact already claimed the instant
  before pause still completes that one in-flight dial - you can't un-ring a phone that already rang)
  and get picked up again the next time the campaign is started.

A `docker-compose.yml` at the repo root defines throwaway Postgres (`localhost:55432`) and Redis
(`localhost:56379`) containers on non-default ports, so they won't collide with anything else you have
running locally.

```bash
npm run e2e:up       # start dockerized Postgres + Redis (docker compose up -d --wait)
npm run e2e:migrate  # push the Prisma schema to the e2e database (prisma db push — no migrations/ dir yet)
npx nx run e2e:e2e   # run the e2e suite (or just: npm run e2e, which chains all three)
npm run e2e:down     # tear the containers down
```

Requires Docker (with the `docker compose` plugin) installed locally. CI runs this same suite as a
separate `e2e` job using GitHub Actions service containers instead of `docker compose` — see
`.github/workflows/ci.yml`.
