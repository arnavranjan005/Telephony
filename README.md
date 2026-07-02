# Telephony

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
- In-process scheduler that drives campaign and follow-up dialing automatically
- Global DNC (Do-Not-Call) list enforced on every outbound-dialing path

## Project layout

```
src/
  config/        env loading (zod-validated) and the Prisma client singleton
  lib/ai/        provider-agnostic AIAgent interface, tool definitions, Google implementation
  lib/telnyx/    Telnyx client, call control actions, webhook signature verification
  lib/google-calendar/  OAuth client + calendar availability/booking service
  lib/compliance/  DNC list service (isNumberOnDnc/addToDnc/removeFromDnc/listDnc)
  controllers/   request handlers
  routes/        Express routers
  services/      call ↔ AI agent orchestration, outbound dialing, campaigns, follow-ups, scheduler
  sse/           in-process event bus + SSE endpoint handler
  middleware/    error handling
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
   created via `POST /api/calls/outbound`.
2. `call.answered` → starts Telnyx transcription and speaks a greeting.
3. `call.transcription` (final transcript) → `handleCallerUtterance` persists the utterance, runs
   the AI agent with calendar/lead tools attached, persists the resulting turns, publishes them to
   the SSE bus, and speaks the final reply back on the call.
4. `call.hangup` → marks the call completed.

If the call belongs to a campaign contact, the campaign's `script` is appended to the AI agent's
system prompt for that call. The agent also has `add_to_dnc` (adds the caller to the DNC list the
moment they ask to stop being contacted) and `schedule_followup` (books an automatic callback)
tools available on every call, alongside the calendar and lead tools.

## Automated dialing (campaigns & follow-ups)

`src/services/schedulerService.ts` runs an in-process `setInterval` loop (default: every 30s,
started from `server.ts`) that:
1. Dials any `FollowUp` whose `scheduledAt` has passed (`followUpService.dispatchDueFollowUps`).
2. Dials `PENDING` contacts of any `RUNNING` `Campaign` (`campaignService.dispatchNextCampaignContacts`).

Both dispatch through `src/services/outboundDialService.ts`, the single dialing path shared with the
manual `POST /api/calls/outbound` endpoint — every outbound call, however it originates, checks the
DNC list first and is skipped (marked `SKIPPED_DNC`) if the number is listed. No external job queue
is used, in keeping with the "no recurring platform fees, self-hosted" requirement; if this ever
needs to run across multiple instances, swap the interval loop for a real queue without touching the
dispatch functions themselves.

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
