import assert from "node:assert/strict";
import test from "node:test";
import { RequestProgressStore } from "../src/runtime/request-progress.js";

test("request progress distinguishes provider retry, validation, and save completion", () => {
  const store = new RequestProgressStore();
  store.start("request-1", "project-1");
  store.providerEvent("request-1", {
    phase: "PROVIDER_ATTEMPT",
    attempt: 1,
    maxAttempts: 2,
    streaming: true
  });
  assert.equal(store.get("request-1")?.phase, "PROVIDER_CALL");

  store.providerEvent("request-1", {
    phase: "PROVIDER_RETRY",
    attempt: 2,
    maxAttempts: 2,
    reason: "http_500"
  });
  assert.equal(store.get("request-1")?.phase, "PROVIDER_RETRY");

  store.providerEvent("request-1", {
    phase: "PROVIDER_RESPONSE",
    attempt: 2,
    outputTokens: 4065,
    toolCallCount: 1
  });
  assert.match(store.get("request-1")?.detail ?? "", /4065 output tokens/);

  store.update("request-1", "COMPLETED", "saved");
  assert.equal(store.get("request-1")?.completed, true);
});
