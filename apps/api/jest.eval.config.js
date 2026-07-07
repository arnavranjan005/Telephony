/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/../../__mocks__"],
  testMatch: ["**/*.eval-test.ts"],
  setupFiles: ["<rootDir>/tests/setupEnv.ts"],
  // Chain cases drive several real generateReply rounds through runConversationTurn,
  // each paying the rate-limit gap (and possibly a 429 retry) - 120s was already tight
  // for a single retried call, so multi-round chains need more headroom.
  testTimeout: 300000,
  moduleNameMapper: {
    "^@telephony/(.*)$": "<rootDir>/../../packages/$1/src/index.ts",
  },
};
