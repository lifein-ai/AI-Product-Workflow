import assert from "node:assert/strict";
import test from "node:test";
import { createSubmissionGuard } from "../src/web/submission-guard.js";

function fixture() {
  const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const guard = createSubmissionGuard({ log: (event, detail) => events.push({ event, detail }) });
  return { guard, events };
}

test("a single submit creates one initial request and releases after success", () => {
  const { guard, events } = fixture();
  const action = guard.begin("user-message");
  assert.ok(action);
  assert.equal(guard.isActive(), true);
  guard.finish(action);
  assert.equal(guard.isActive(), false);
  assert.deepEqual(events.map(item => item.event), ["Initial Request"]);
});

test("rapid click and Enter plus click are classified as duplicate requests", () => {
  const { guard, events } = fixture();
  const enterAction = guard.begin("user-message", { source: "enter" });
  assert.ok(enterAction);
  assert.equal(guard.begin("user-message", { source: "click" }), null);
  assert.equal(guard.begin("user-message", { source: "rapid-click" }), null);
  assert.deepEqual(events.map(item => item.event), ["Initial Request", "Duplicate Request", "Duplicate Request"]);
});

test("re-render cannot replace the active action and a stale completion cannot release it", () => {
  const { guard } = fixture();
  const action = guard.begin("initial-discovery");
  assert.ok(action);
  assert.equal(guard.begin("initial-discovery", { source: "after-render" }), null);
  guard.finish({ kind: "initial-discovery", requestId: action.requestId });
  assert.equal(guard.isActive(), true);
  guard.finish(action);
  assert.equal(guard.isActive(), false);
});

test("failed request releases the action so an explicit retry gets a new request id", () => {
  const { guard, events } = fixture();
  const failed = guard.begin("user-message");
  assert.ok(failed);
  guard.finish(failed);
  const retry = guard.begin("retry");
  assert.ok(retry);
  assert.notEqual(retry.requestId, failed.requestId);
  assert.deepEqual(events.map(item => item.event), ["Initial Request", "Initial Request"]);
});
