/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/../../__mocks__"],
  testMatch: ["**/*.eval-test.ts"],
  setupFiles: ["<rootDir>/tests/setupEnv.ts"],
  testTimeout: 120000,
  moduleNameMapper: {
    "^@telephony/(.*)$": "<rootDir>/../../packages/$1/src/index.ts",
  },
};
