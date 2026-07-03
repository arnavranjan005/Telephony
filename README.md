# Telephony

[![CI](https://github.com/arnavranjan005/Telephony/actions/workflows/ci.yml/badge.svg)](https://github.com/arnavranjan005/Telephony/actions/workflows/ci.yml)

AI voice calling platform: outbound/inbound calls via Telnyx, appointment
booking via Google Calendar, a provider-agnostic AI agent with tool calling
(Google Gemini by default), automated outbound campaigns and callback
follow-ups, TCPA/DNC compliance, a distributed BullMQ dial worker, Prisma on
Neon Postgres, a REST API, Server-Sent Events for live call updates, and a
Next.js admin panel.

This is a foundation to build on, not the full feature set described in the
requirements doc (no analytics dashboard, sentiment logic, or live
bidirectional audio streaming yet — see "Not yet implemented" below).

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

- `POST /api/calls/outbound` `{ toNumber, leadId? }` — place an outbound call
- `GET /api/calls` / `GET /api/calls/:callId` — list/inspect calls (includes conversation history)
- `GET /api/calls/:callId/events` — SSE stream of call status + AI conversation turns
- `POST /api/calls/webhook` — Telnyx webhook receiver (call.initiated/answered/transcription/hangup)
- `POST /api/leads`, `GET /api/leads`, `GET /api/leads/:leadId`, `PATCH /api/leads/:leadId`, `DELETE /api/leads/:leadId`
- `GET /api/calendar/busy?timeMin=&timeMax=` — free/busy lookup
- `POST /api/calendar/appointments` `{ title, startTime, endTime, leadId?, callId?, attendeeEmail? }` — book directly via REST
- `GET /api/appointments`, `GET /api/appointments/:id`, `POST /api/appointments/:id/cancel`
- `POST /api/campaigns` `{ name, script?, contacts: [{ leadId? | phoneNumber, firstName?, lastName? }] }` — create a campaign (upserts leads from phone numbers)
- `GET /api/campaigns`, `GET /api/campaigns/:id`, `POST /api/campaigns/:id/start`, `POST /api/campaigns/:id/pause` — the dial worker processes `PENDING` contacts of any `RUNNING` campaign automatically and marks it `COMPLETED` once none are left
- `POST /api/followups` `{ leadId, scheduledAt, reason? }` — schedule a callback; the dial worker dials it automatically once due
- `GET /api/followups`, `POST /api/followups/:id/cancel`
- `GET /api/dnc`, `POST /api/dnc` `{ phoneNumber, reason? }`, `DELETE /api/dnc/:phoneNumber` — global Do-Not-Call list; every outbound dial (manual, campaign, or follow-up) is checked against it first

### Consuming the SSE stream

```js
const source = new EventSource(`/api/calls/${callId}/events`);
source.addEventListener("conversation.message", (e) => console.log(JSON.parse(e.data)));
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

Currently ships with one page (a leads list) as a proof that the wiring
works end-to-end, typed against `@telephony/shared-types`. The rest of the
admin UI (call logs, campaign management, appointment calendar, live call
monitoring over the SSE stream) is intentionally not built yet — this was
scoped as "get the skeleton right first."

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
  the DNC list first and is skipped (marked `SKIPPED_DNC`) if the number is listed.

`apps/api` and `apps/worker` are independently deployable and scalable — run `npm run dev:api` and
`npm run dev:worker` as separate processes (locally, that's two terminals; in production, two
separate deployments pointed at the same Postgres and Redis).

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

The full requirements doc describes a much larger system. This intentionally leaves out: the rest of
the admin panel UI beyond the one proof-of-wiring page, sentiment analysis (detecting caller sentiment
mid-call to trigger retention logic), an analytics dashboard (call/campaign/conversion metrics), and
live bidirectional audio streaming (current inbound/outbound conversation flow uses Telnyx's
transcription + TTS webhooks rather than raw media streaming, and voice is whatever Telnyx's TTS
provides — no custom paralinguistic fillers/pacing). These fit into the same architecture — new
routes/services/tools/pages — and are natural next increments.

## Scripts (run from the repo root)

- `npm run dev:api` / `npm run dev:worker` / `npm run dev:web` — dev servers with hot reload
- `npm run build` — build every project (`nx run-many -t build --all`)
- `npm run typecheck` — TypeScript check every project
- `npm test` — run every project's test suite
- `npx nx run database:prisma-studio` — browse the database
- `npx nx graph` — visualize the project dependency graph

## End-to-end tests (`apps/e2e`)

Everything above (`npm test`) runs with Prisma, Redis, and Telnyx mocked — it checks each unit/route
in isolation. `apps/e2e` is different: it boots the real Express app (`createApp()`) and a real
in-process BullMQ `Worker` (`startWorker()`) against **real** Postgres and Redis running in Docker,
and drives them with real HTTP requests. Only the `telnyx` package is mocked (it needs a real account
and costs money to call for real) — Prisma, BullMQ, and every domain service run unmocked. This is the
only place in the repo that proves the atomic `PENDING -> CALLING` claim logic (used by both
`followUpService` and `campaignService` to avoid double-dialing when multiple workers race on the same
row) actually holds under real Postgres row locking, not just against a mocked Prisma client.

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
