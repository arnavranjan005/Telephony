/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.e2e-test.ts"],
  clearMocks: true,
  setupFiles: ["<rootDir>/tests/setupEnv.ts"],
  testTimeout: 30000,
  moduleNameMapper: {
    "^@telephony/(.*)$": "<rootDir>/../../packages/$1/src/index.ts",
  },
};
