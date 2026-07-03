/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/../../__mocks__"],
  testMatch: ["**/*.test.ts"],
  clearMocks: true,
  moduleNameMapper: {
    "^@telephony/(.*)$": "<rootDir>/../../packages/$1/src/index.ts",
  },
};
