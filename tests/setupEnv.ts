jest.mock("bullmq");

process.env.DATABASE_URL ??= "postgresql://user:password@localhost:5432/telephony_test";
process.env.REDIS_URL ??= "rediss://default:test-password@test-redis.aivencloud.com:12345";
process.env.TELNYX_API_KEY ??= "test_telnyx_api_key";
process.env.TELNYX_CONNECTION_ID ??= "test_connection_id";
process.env.TELNYX_FROM_NUMBER ??= "+15550000000";
process.env.AI_PROVIDER ??= "google";
process.env.GOOGLE_AI_API_KEY ??= "test_google_ai_key";
process.env.GOOGLE_CALENDAR_ID ??= "primary";
