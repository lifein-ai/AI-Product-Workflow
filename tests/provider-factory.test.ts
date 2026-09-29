import assert from "node:assert/strict";
import test from "node:test";
import { createAIProvider } from "../src/ai/provider-factory.js";
import { ProviderLibrary } from "../src/ai/provider-library.js";

test("Provider Factory defaults to Relay and is the only AI_PROVIDER decision point", () => {
  const selected = createAIProvider({
    MODELFLARE_API_KEY: "test",
    MODELFLARE_BASE_URL: "https://relay.invalid/v1",
    MODELFLARE_MODEL: "test-model"
  }, { libraryPath: null });
  assert.ok(selected.provider instanceof ProviderLibrary);
  assert.equal(typeof selected.initialize, "function");
  assert.deepEqual(selected.info, { id: "relay", label: "Relay", status: "Ready" });
  assert.equal(selected.library.getState().active.activeModel, "test-model");
});

test("Provider Factory selects Local Codex", () => {
  const selected = createAIProvider({ AI_PROVIDER: "codex" }, { libraryPath: null });
  assert.ok(selected.provider instanceof ProviderLibrary);
  assert.equal(typeof selected.initialize, "function");
  assert.deepEqual(selected.info, { id: "codex", label: "Codex Local", status: "Ready" });
});

test("Provider Factory rejects missing Relay configuration and unknown providers", () => {
  assert.throws(() => createAIProvider({ AI_PROVIDER: "relay" }, { libraryPath: null }), /Provider initialization failed/);
  assert.throws(() => createAIProvider({ AI_PROVIDER: "unknown" }, { libraryPath: null }), /Use relay or codex/);
});
