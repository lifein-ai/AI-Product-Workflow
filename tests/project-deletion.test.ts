import assert from "node:assert/strict";
import test from "node:test";
import { createProjectDeletionController } from "../src/web/project-deletion.js";

function fixture({ activeProjectId = "current", confirmed = true } = {}) {
  const calls: string[] = [];
  const deleted = new Set<string>();
  const controller = createProjectDeletionController({
    confirmDelete(message) {
      calls.push(`confirm:${message}`);
      return confirmed;
    },
    async deleteById(projectId) {
      calls.push(`delete:${projectId}`);
      deleted.add(projectId);
    },
    getActiveProjectId: () => activeProjectId,
    clearActiveProject: () => calls.push("clear-active"),
    removeProjectFromHistory: projectId => calls.push(`remove-history:${projectId}`),
    async refreshProjects() {
      calls.push("refresh");
    },
    onConfirmed: () => calls.push("confirmed"),
    onSettled: () => calls.push("settled")
  });
  return { calls, controller, deleted };
}

test("deleting a non-current project updates history without clearing the active project", async () => {
  const { calls, controller, deleted } = fixture({ activeProjectId: "current" });

  const result = await controller.deleteProject({ id: "other", name: "Other" });

  assert.deepEqual(result, { deleted: true, wasActive: false });
  assert.equal(deleted.has("other"), true);
  assert.equal(calls.includes("clear-active"), false);
  assert.deepEqual(calls.slice(1), ["confirmed", "delete:other", "remove-history:other", "refresh", "settled"]);
});

test("deleting the current project clears active state after persistent deletion", async () => {
  const { calls, controller } = fixture({ activeProjectId: "current" });

  const result = await controller.deleteProject({ id: "current", name: "Current" });

  assert.deepEqual(result, { deleted: true, wasActive: true });
  assert.ok(calls.indexOf("delete:current") < calls.indexOf("clear-active"));
  assert.ok(calls.indexOf("clear-active") < calls.indexOf("refresh"));
});

test("cancel has no delete, state, history, busy, or refresh side effects", async () => {
  const { calls, controller, deleted } = fixture({ confirmed: false });

  const result = await controller.deleteProject({ id: "current", name: "Current" });

  assert.deepEqual(result, { deleted: false, wasActive: false });
  assert.equal(deleted.size, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^confirm:Delete “Current”/);
});

test("a deleted project id is rejected by late hydration", async () => {
  const { controller } = fixture({ activeProjectId: "current" });

  await controller.deleteProject({ id: "current", name: "Current" });

  assert.equal(controller.wasDeleted("current"), true);
  assert.equal(controller.wasDeleted("other"), false);
  assert.deepEqual(
    controller.excludeDeletedProjects([{ id: "current" }, { id: "other" }]),
    [{ id: "other" }]
  );
});
