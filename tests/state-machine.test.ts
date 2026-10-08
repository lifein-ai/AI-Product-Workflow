import assert from "node:assert/strict";
import test from "node:test";
import { createProjectRecord } from "../src/domain/factories.js";
import { applyReadyEvaluation, confirmStage, markStageContentChanged, reopenDiscovery, reopenSolution, startStage } from "../src/workflow/state-machine.js";

test("Discovery can become ready then confirmed", () => {
  const project = createProjectRecord("PK", "做主播PK");
  applyReadyEvaluation(project, "DISCOVERY", {
    criteria: [],
    blockingUnknownIds: [],
    result: "READY",
    summary: "ready",
    evaluatedContentVersion: 0,
    dependencySnapshot: {}
  });
  assert.equal(project.workflow.stages.DISCOVERY.status, "READY_FOR_CONFIRMATION");
  confirmStage(project, "DISCOVERY");
  assert.equal(project.workflow.stages.DISCOVERY.status, "CONFIRMED");
});

test("Editing confirmed Discovery invalidates downstream started stages", () => {
  const project = createProjectRecord("PK", "做主播PK");
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.SOLUTION.status = "CONFIRMED";
  project.workflow.stages.INTERACTION.status = "IN_PROGRESS";
  markStageContentChanged(project, "DISCOVERY");
  assert.equal(project.workflow.stages.DISCOVERY.status, "IN_PROGRESS");
  assert.equal(project.workflow.stages.SOLUTION.status, "NEEDS_REVIEW");
  assert.equal(project.workflow.stages.INTERACTION.status, "NEEDS_REVIEW");
});

test("starting Solution requires confirmed Discovery and records the dependency", () => {
  const project = createProjectRecord("PK", "做主播PK");
  assert.throws(() => startStage(project, "SOLUTION"));
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.DISCOVERY.confirmedVersion = 3;
  startStage(project, "SOLUTION");
  assert.equal(project.workflow.activeStage, "SOLUTION");
  assert.equal(project.workflow.stages.SOLUTION.status, "IN_PROGRESS");
  assert.deepEqual(project.workflow.stages.SOLUTION.dependencySnapshot, { DISCOVERY: 3 });
});

test("a blocked PRD can explicitly reopen confirmed Solution for missing product input", () => {
  const project = createProjectRecord("Reopen", "Need a product rule");
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.DISCOVERY.confirmedVersion = 1;
  project.workflow.stages.SOLUTION.status = "CONFIRMED";
  project.workflow.stages.SOLUTION.contentVersion = 2;
  project.workflow.stages.SOLUTION.confirmedVersion = 2;
  project.workflow.activeStage = null;
  project.artifacts.prd.reviewStatus = "BLOCKED";
  project.artifacts.prd.blockingIssues = ["A product rule is missing"];

  reopenSolution(project);

  assert.equal(project.workflow.activeStage, "SOLUTION");
  assert.equal(project.workflow.stages.SOLUTION.status, "IN_PROGRESS");
  assert.equal(project.workflow.stages.SOLUTION.confirmedVersion, undefined);
  assert.equal(project.artifacts.prd.lifecycleStatus, "STALE");
});

test("reopening confirmed Discovery returns to conversation and invalidates downstream work", () => {
  const project = createProjectRecord("Reopen Discovery", "Update the target user");
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.DISCOVERY.confirmedVersion = 1;
  project.workflow.stages.SOLUTION.status = "CONFIRMED";
  project.workflow.stages.SOLUTION.confirmedVersion = 2;
  project.workflow.activeStage = null;
  project.artifacts.prd.lifecycleStatus = "CURRENT";
  project.artifacts.interaction.lifecycleStatus = "CURRENT";
  project.artifacts.figmaPrompt.lifecycleStatus = "CURRENT";

  reopenDiscovery(project);

  assert.equal(project.workflow.activeStage, "DISCOVERY");
  assert.equal(project.workflow.stages.DISCOVERY.status, "IN_PROGRESS");
  assert.equal(project.workflow.stages.SOLUTION.status, "NEEDS_REVIEW");
  assert.equal(project.artifacts.prd.lifecycleStatus, "STALE");
  assert.equal(project.artifacts.interaction.lifecycleStatus, "STALE");
  assert.equal(project.artifacts.figmaPrompt.lifecycleStatus, "STALE");
});
