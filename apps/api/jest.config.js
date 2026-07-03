/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/tests", "<rootDir>/../../__mocks__"],
  testMatch: ["**/*.test.ts"],
  clearMocks: true,
  setupFiles: ["<rootDir>/tests/setupEnv.ts"],
  moduleNameMapper: {
    "^@telephony/(.*)$": "<rootDir>/../../packages/$1/src/index.ts",
  },
};
