// Real Postgres + Redis (docker-compose.yml) - this suite exercises the
// actual distributed-claim logic against real infrastructure, so unlike the
// unit/integration suites it must NOT mock bullmq or point at fake hosts.
process.env.DATABASE_URL ??= "postgresql://telephony:telephony@localhost:55432/telephony_e2e";
process.env.REDIS_URL ??= "redis://localhost:56379";
process.env.REDIS_TLS_REJECT_UNAUTHORIZED ??= "false";

process.env.TELNYX_API_KEY ??= "test_telnyx_api_key";
process.env.TELNYX_CONNECTION_ID ??= "test_connection_id";
process.env.TELNYX_FROM_NUMBER ??= "+15550000000";
process.env.AI_PROVIDER ??= "google";
process.env.GOOGLE_AI_API_KEY ??= "test_google_ai_key";
process.env.GOOGLE_CALENDAR_ID ??= "primary";
process.env.DIAL_RATE_LIMIT_MAX ??= "5";
process.env.DIAL_RATE_LIMIT_DURATION_MS ??= "1000";
