# Deployment

How to run Telephony in production. For local development setup, see
[README.md](README.md#setup).

## What you deploy

Three build artifacts, two managed data services, and five external providers:

| Component | What it is | Runtime |
|---|---|---|
| `apps/api` | Express REST API + Telnyx webhook receiver + SSE streams + `ws` media-stream WebSocket server | Long-running Node process, public HTTPS |
| `apps/worker` | BullMQ dial-job consumer (campaigns + follow-ups) | Long-running Node process, no inbound ports |
| `apps/web` | Next.js admin panel, `output: "export"` | Static files only — any static host/CDN, no Node process |
| Postgres | Prisma datasource (built against [Neon](https://neon.tech), any Postgres works) | Managed service |
| Redis | BullMQ queue backing store (built against Aiven, TLS `rediss://`) | Managed service |

External providers you need accounts/keys for: **Telnyx** (telephony),
**Google Cloud** (OAuth client for Calendar), **Google AI Studio** (Gemini API
key), **Deepgram** (streaming STT), **ElevenLabs** (streaming TTS). Deepgram
and ElevenLabs are only required while `MEDIA_STREAM_ENABLED=true` (the
default); see [Environment variables](#environment-variables).

`apps/api` and `apps/worker` are independent processes that share the same
`DATABASE_URL` and `REDIS_URL`. Deploy them separately and scale the worker
independently of the API — but read [Topology constraints](#topology-constraints)
first, because parts of the API are currently single-instance.

There are no Dockerfiles in this repo. The root `docker-compose.yml` is
**not** a deployment artifact — it only provides throwaway Postgres/Redis
containers for the local e2e test suite.

## Requirements

- Node.js ≥ 18 (`package.json` `engines`; CI runs Node 22 — prefer that)
- npm (workspaces are used for linking; the lockfile is `package-lock.json`)
- Outbound internet from both API and worker (Telnyx, Google, Deepgram,
  ElevenLabs APIs)
- A public HTTPS domain for the API. Telnyx must be able to reach it for
  webhooks **and** open a WebSocket to it for media streaming (`BASE_URL` is
  rewritten `https://` → `wss://` to build the `stream_url` passed to Telnyx —
  see `packages/domain/src/mediaStream/streamAuth.ts`).

## Environment variables

All configuration is validated at process start by
`packages/config/src/env.ts` (zod). A missing required variable makes the API
**and** the worker exit immediately with a clear error, so misconfiguration
fails fast rather than at first use. In development the loader also reads a
single `.env` at the repo root; in production, set real environment variables
on each process (both API and worker need the full set — the worker dials
calls too).

### Required always

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string. For Neon include `?sslmode=require`. |
| `REDIS_URL` | `rediss://` (TLS) connection string, e.g. Aiven. Plain `redis://` also works if your Redis has no TLS. |
| `TELNYX_API_KEY` | Telnyx portal → API keys. |
| `TELNYX_CONNECTION_ID` | The Telnyx Call Control application id. |
| `TELNYX_FROM_NUMBER` | E.164 caller-id number owned in Telnyx. |

### Required while `MEDIA_STREAM_ENABLED=true` (the default)

| Variable | Notes |
|---|---|
| `DEEPGRAM_API_KEY` | Streaming STT. |
| `ELEVENLABS_API_KEY` | Streaming TTS. |
| `ELEVENLABS_VOICE_ID` | The ElevenLabs voice used for every call. |

Set `MEDIA_STREAM_ENABLED=false` to fall back to the legacy
transcribe-then-speak webhook flow (no barge-in) and drop these three.

### Strongly recommended in production

| Variable | Default | Notes |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | **Must** be set to the API's public HTTPS origin (e.g. `https://api.example.com`). Used to build the `wss://` media-stream URL handed to Telnyx; streaming calls cannot connect without it. |
| `NODE_ENV` | `development` | Set `production` (enables `combined` request logging; see also the web-build gotcha below). |
| `TELNYX_PUBLIC_KEY` | — | Enables Ed25519 signature verification on `POST /api/calls/webhook` (`apps/api/src/telnyx/webhookVerifier.ts`). Without it, the webhook endpoint accepts unauthenticated payloads. |

### Optional / tuning

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | API listen port. |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | `true` | Keep `true`; `false` is only an escape hatch for broken CA chains. |
| `DIAL_RATE_LIMIT_MAX` / `DIAL_RATE_LIMIT_DURATION_MS` | `5` / `1000` | Worker-side outbound dial throughput cap (jobs per window), applied per worker instance. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | — | OAuth client for Calendar. `GOOGLE_REDIRECT_URI` must be `https://<api-domain>/api/calendar/oauth/callback` and registered on the OAuth client. |
| `GOOGLE_REFRESH_TOKEN` | — | Obtained once via the OAuth flow ([below](#3-connect-google-calendar)). Calendar booking fails without it. |
| `GOOGLE_CALENDAR_ID` | `primary` | Which calendar to book into. |
| `AI_PROVIDER` | `google` | Only `google` (Gemini) is implemented today. |
| `GOOGLE_AI_API_KEY` | — | Gemini key; the AI agent cannot reply without it. |
| `GOOGLE_AI_MODEL` | `gemini-2.5-flash` | |
| `MEDIA_STREAM_WS_PATH` | `/media-stream` | WebSocket upgrade path on the API server. |
| `MEDIA_STREAM_SAMPLE_RATE` | `8000` | |
| `DEEPGRAM_MODEL` | `nova-2-phonecall` | |
| `ELEVENLABS_STABILITY` / `ELEVENLABS_SIMILARITY_BOOST` / `ELEVENLABS_STYLE` / `ELEVENLABS_SPEAKER_BOOST` / `ELEVENLABS_SPEED` | `0.45` / `0.8` / `0.3` / `true` / `1.0` | Voice tuning passed through as ElevenLabs `voice_settings`. |

The web app has exactly one variable, **baked in at build time** (it's a
static export — there is no runtime env):

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_API_URL` | Public URL of the deployed API, set in the environment (or `apps/web/.env.local`) when running `web:build`. Changing it requires a rebuild. |

## Build

From the repo root, on your build machine/CI:

```bash
npm ci
npx nx run database:prisma-generate   # generates the Prisma client
npm run build                         # nx run-many -t build --all
```

Nx builds in dependency order (Prisma client generation runs before anything
that imports `@telephony/database`). Outputs:

- `apps/api/dist/` — start with `node apps/api/dist/server.js` (or
  `npm run start -w @telephony/api`)
- `apps/worker/dist/` — start with `node apps/worker/dist/worker.js` (or
  `npm run start -w @telephony/worker`)
- `apps/web/out/` — static directory; upload to any static host/CDN

The compiled API and worker still resolve `@telephony/*` packages through
`node_modules` workspace symlinks, so the simplest deployment unit is the
whole repo checkout after `npm ci && npm run build` (dev dependencies can be
pruned afterward with `npm prune --omit=dev`). If you package individual apps
into containers instead, include the built `packages/*/dist` outputs and the
generated Prisma client with them.

> **Web build gotcha:** never let `NODE_ENV=development` leak into
> `next build`. The `web:build` script pins `NODE_ENV=production` itself, but
> if you invoke Next through another orchestrator, an inherited
> `NODE_ENV=development` breaks static prerendering (see README, "Build
> gotcha").

## Database schema

`packages/database/prisma/schema.prisma` is the source of truth. There is
**no `prisma/migrations/` directory in the repo yet**, so `prisma migrate
deploy` has nothing to apply until a first migration is committed. Two options:

- **Schema push (matches current practice):** apply the schema directly —
  what the e2e suite and the README setup flow do today.

  ```bash
  DATABASE_URL=<prod-url> npx prisma db push \
    --schema packages/database/prisma/schema.prisma --skip-generate
  ```

- **Real migrations (recommended once data matters):** create the initial
  migration locally with `npx nx run database:prisma-migrate`
  (`prisma migrate dev`), commit `prisma/migrations/`, and from then on run
  the already-wired deploy script against production before rolling new code:

  ```bash
  DATABASE_URL=<prod-url> npm run prisma:deploy -w @telephony/database
  ```

Run schema changes **before** starting the new API/worker builds that depend
on them.

## Deploying `apps/api`

- Single Node process serving HTTP, SSE, and WebSocket upgrades on `PORT`.
- **Health check:** `GET /health` returns `{ "status": "ok", ... }` — wire it
  to your platform's liveness/readiness probe.
- **Reverse proxy / platform requirements:**
  - WebSocket upgrade support on `MEDIA_STREAM_WS_PATH` (default
    `/media-stream`). Telnyx connects here once per streaming call.
  - No response buffering on `GET /api/events/stream` and
    `GET /api/calls/:callId/events` (SSE). For nginx: `proxy_buffering off`
    (the endpoints already send appropriate SSE headers); most PaaS routers
    (Render, Railway, Fly, Heroku) pass SSE through fine.
  - Generous or disabled idle timeouts for those SSE/WebSocket connections —
    calls and dashboard sessions are long-lived.
  - TLS termination at the proxy is fine; the app listens on plain HTTP.
- **Graceful shutdown:** there are no custom signal handlers; in-flight
  streaming calls on an instance die with it. Prefer rolling restarts during
  quiet hours.
- Request logs go to stdout via morgan (`combined` format when
  `NODE_ENV=production`); errors to stderr. Ship stdout/stderr to your log
  system.

## Deploying `apps/worker`

- Single Node process, no inbound ports — a "background worker" on any PaaS.
- Needs the **same env** as the API (it dials through Telnyx and reads/writes
  the same Postgres/Redis).
- On startup it runs `reconcilePendingWork()`: every DB row still `PENDING`
  or `WAITING_FOR_CALLING_HOURS` is re-enqueued. Deterministic job IDs +
  atomic DB status claims make this safe to run on every boot and safe to run
  from multiple instances — it also means **a Redis flush/eviction is
  recoverable by restarting a worker** (relevant on Aiven's free tier).
- Scale horizontally freely: double-dial protection is a Postgres
  compare-and-swap claim (`PENDING → CALLING`), not a queue-level guarantee.
  Note `DIAL_RATE_LIMIT_MAX` is enforced **per worker instance**, so total
  Telnyx throughput ≈ instances × limit — lower the per-instance limit if you
  scale out.
- **Caveat for streaming automated dials:** see topology constraint #2 below
  before scaling the worker with `MEDIA_STREAM_ENABLED=true`.

## Deploying `apps/web`

- `npx nx run web:build` with `NEXT_PUBLIC_API_URL` pointing at the deployed
  API produces `apps/web/out/` — pure static files. Serve from S3+CloudFront,
  Netlify, Vercel (static), GitHub Pages, nginx, anything. No Node runtime.
- Rebuild + redeploy whenever the API URL changes; the value is compiled into
  the JS bundle.
- The panel talks to the API from the **browser**, so the API must be
  reachable from your users' network, and CORS must allow the panel's origin
  (it currently allows all origins — see [Security](#security-notes)).

## Post-deploy wiring (first deployment)

### 1. Point Telnyx at the API

In the Telnyx portal, set your Call Control application's webhook URL to:

```
https://<api-domain>/api/calls/webhook
```

Set `TELNYX_PUBLIC_KEY` (portal → API keys → public key) so signatures are
verified. Confirm `TELNYX_CONNECTION_ID` matches this application and
`TELNYX_FROM_NUMBER` is one of its numbers.

**Inbound calls are recorded.** The answer command requests dual-channel MP3
recording (`record-from-answer` — see `answerCall` in
`packages/domain/src/telnyx/callService.ts`), so make sure call recording is
permitted on your Telnyx account/plan. When Telnyx finishes a recording it
delivers a `call.recording.saved` event to the same webhook URL, and the MP3
URL is stored on `Call.recordingUrl` — no extra configuration needed.

### 2. Verify `BASE_URL`

`BASE_URL` must equal the API's public HTTPS origin. It is embedded (as
`wss://…`) into the `stream_url` Telnyx uses to open the media stream; a
wrong value means streaming calls connect the phone leg but never any audio
processing.

### 3. Connect Google Calendar

One-time bootstrap for the long-lived refresh token:

1. With the API deployed and `GOOGLE_CLIENT_ID`/`SECRET`/`REDIRECT_URI` set,
   call `GET https://<api-domain>/api/calendar/oauth/url` and open the
   returned consent URL in a browser.
2. Approve; Google redirects to `/api/calendar/oauth/callback`, which returns
   a `refresh_token`.
3. Set it as `GOOGLE_REFRESH_TOKEN` on the API (and worker) and restart.

### 4. Smoke test

```bash
curl https://<api-domain>/health
curl https://<api-domain>/api/analytics/overview          # exercises Postgres
curl -X POST https://<api-domain>/api/calls/outbound \
  -H 'Content-Type: application/json' \
  -d '{"toNumber": "+1<your-cell>"}'                       # end-to-end: Telnyx, streaming, AI
```

Then watch the call appear live on the admin panel dashboard (proves SSE
passes through your proxy).

## Topology constraints

Postgres is the source of truth throughout, and the write paths (idempotency
keys, dial claims, campaign transactions) are safe under concurrency. But
three pieces of API state are **in-process memory**, which constrains the
topology today:

1. **SSE event bus** (`apps/api/src/sse/eventBus.ts`) is a per-process
   `EventEmitter`. With multiple API instances, a dashboard connected to
   instance A never sees events for a webhook handled by instance B.
2. **Media-stream auth tokens** (`packages/domain/src/mediaStream/streamAuth.ts`)
   are an in-process map: issued by whichever process places/answers the call,
   verified by the API process Telnyx's WebSocket lands on (single-use,
   5-minute TTL). Two consequences:
   - Multiple API instances need the WebSocket to land on the same instance
     that issued the token — not guaranteed by round-robin routing.
   - **Campaign/follow-up dials are placed by the worker process**, so their
     tokens live in the worker's memory and the API can't verify them. Until
     the token store moves to Redis, streaming automated dials only work when
     worker and API share a process (as the e2e suite does). In a standard
     split deployment, create campaigns/follow-ups with
     `{ "streamingEnabled": false }` so automated dials use the legacy webhook
     flow; manual (`POST /api/calls/outbound`) and inbound calls stream fine.
3. **Per-call streaming sessions** hold live WebSocket + Deepgram + ElevenLabs
   connections on one instance (unavoidable and fine — but it means draining
   an instance kills its active calls).

**Bottom line:** run exactly **one API instance** (scaled vertically) unless
you add a Redis-backed token store and event bus plus sticky routing. The
worker scales horizontally today, with caveat #2 above.

## Security notes

- **The REST API has no authentication.** Anyone who can reach it can place
  calls, read transcripts, and edit leads. Do not expose it raw to the
  internet: put it behind a VPN/private network, an authenticating reverse
  proxy (OAuth2-proxy, Cloudflare Access, etc.), or add auth middleware before
  going live. Only `/api/calls/webhook` (Telnyx signature) and
  `/media-stream` (single-use token) carry their own verification.
- **CORS is wide open** (`app.use(cors())` in `apps/api/src/app.ts`). If you
  add cookie/header-based auth, restrict the origin to the admin panel's
  domain.
- Set `TELNYX_PUBLIC_KEY` in production — without it webhook signatures are
  not checked.
- Keep `REDIS_TLS_REJECT_UNAUTHORIZED=true`.
- All secrets arrive via environment variables; nothing is read from files at
  runtime, so use your platform's secret manager.
- **Call-recording consent is not handled by the app.** Inbound calls are
  recorded (above), and many jurisdictions require announcing that or
  obtaining consent (e.g. two-party-consent states). Add a recording
  disclosure to the greeting/prompt, or strip the `record` parameters from
  `answerCall`, before taking real traffic. The recordings themselves live on
  Telnyx-hosted URLs (only the link is stored in Postgres), so Telnyx's
  storage/retention settings govern them.

## CI/CD

`.github/workflows/ci.yml` runs on every push to `main` and every PR:

1. `build-and-test` — typecheck, unit/integration tests (all external
   boundaries mocked; dummy env values), full build.
2. `e2e` — the real-Postgres/real-Redis suite against GitHub Actions service
   containers.

There is no deploy job; releases are manual. A sensible pipeline: gate deploys
on CI green → apply schema changes → deploy worker → deploy API → build+upload
web with the production `NEXT_PUBLIC_API_URL`.

AI reply-quality evals (`npm run eval:ai`) are **not** in CI — they call the
real Gemini API. Run them manually (with a real `GOOGLE_AI_API_KEY`) when
changing prompts or tools.

## Operational notes

- **Redis lost/flushed:** restart (or start another) worker;
  `reconcilePendingWork()` rebuilds the queue from Postgres.
- **Stuck `CALLING` rows:** a worker that crashed mid-dial leaves the row
  claimed; there is no automatic requeue for `CALLING`. Inspect and reset such
  rows manually (`npx nx run database:prisma-studio` locally, or SQL).
- **IdempotencyKey table growth:** cached responses are never purged; add a
  periodic TTL sweep if traffic becomes real.
- **Calling-hours deferrals:** contacts outside the 8am–9pm (callee-local)
  window sit in `WAITING_FOR_CALLING_HOURS` with a delayed retry job — not an
  error, visible in the admin panel with its own badge.
- **Provider outages:** a Google Calendar failure during booking compensates
  by deleting the just-created event; a ≥500 response releases any
  idempotency key so clients can retry safely.
