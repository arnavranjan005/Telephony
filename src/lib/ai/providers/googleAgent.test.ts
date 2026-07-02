import { GoogleAgent } from "./googleAgent";

describe("GoogleAgent", () => {
  it("throws a clear error when constructed without an API key", () => {
    expect(() => new GoogleAgent("")).toThrow(/GOOGLE_AI_API_KEY is required/);
  });

  // Note: googleAgent.ts loads @google/genai (ESM-only, with a broken CJS
  // "require" export condition) via a Function-constructor dynamic import so
  // that a real `import()` runs instead of the require() that tsc's
  // CommonJS output would otherwise substitute. Jest's own module sandbox
  // can't execute a real dynamic import without --experimental-vm-modules,
  // so that specific loading path is verified manually against the compiled
  // output (`node dist/...`) rather than here - see the PR/commit notes.
});
