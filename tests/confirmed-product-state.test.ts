import assert from "node:assert/strict";
import test from "node:test";
import { createProjectRecord } from "../src/domain/factories.js";
import { buildConfirmedProductState } from "../src/workflow/confirmed-product-state.js";
import { markStageContentChanged } from "../src/workflow/state-machine.js";

function confirmedProject() {
  const project = createProjectRecord("Confirmed state", "Improve the current workflow");
  project.productSpec.discovery.hypotheses.push({ id: "h1", statement: "Users miss the current entry" });
  project.productSpec.solution.summary = "Extend the existing workflow";
  project.productSpec.solution.coreSolution = "Reuse the current product and add one guided flow";
  project.productSpec.solution.keyMechanisms.push({ id: "guided", name: "Guided flow", description: "Guide the user through the task" });
  project.productSpec.solution.scope.inScope.push("Guided flow");
  project.productSpec.solution.scope.outOfScope.push("Platform rewrite");
  project.productSpec.solution.keyRules.push({ id: "rule", rule: "Only authorized users continue" });
  project.productSpec.solution.mainProductFlow.push({ id: "start", step: "User starts the task" });
  project.productSpec.solution.tradeOffs.push({ id: "reuse", topic: "Architecture", decision: "Extend existing", rationale: "Lower delivery risk" });
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.DISCOVERY.confirmedVersion = 2;
  project.workflow.stages.SOLUTION.status = "CONFIRMED";
  project.workflow.stages.SOLUTION.confirmedVersion = 4;
  return project;
}

test("Confirmed Product State freezes only active decisions and relevant open questions", () => {
  const project = confirmedProject();
  project.productSpec.decisions.push(
    { id: "active", stage: "SOLUTION", decision: "Extend", rationale: ["Lower risk"], affectedPaths: ["solution.tradeOffs"], status: "ACTIVE" },
    { id: "old", stage: "SOLUTION", decision: "Rewrite", rationale: ["Flexible"], affectedPaths: ["solution.tradeOffs"], status: "SUPERSEDED" },
    { id: "later", stage: "SOLUTION", decision: "Choose animation", rationale: ["Not blocking"], affectedPaths: ["solution.keyRules"], status: "DEFERRED" }
  );
  project.productSpec.openQuestions.push(
    { id: "open", createdInStage: "SOLUTION", ownerStage: "SOLUTION", question: "Which copy?", impact: "Minor", blocking: false, resolutionMethod: "DEFER", status: "OPEN" },
    { id: "resolved", createdInStage: "SOLUTION", ownerStage: "SOLUTION", question: "Which flow?", impact: "Core", blocking: true, resolutionMethod: "PRODUCT_DECISION", status: "RESOLVED", resolution: "Guided" }
  );

  const state = buildConfirmedProductState(project);
  assert.deepEqual(state.activeDecisions.map(item => item.id), ["active"]);
  assert.deepEqual(state.relevantOpenQuestions.map(item => item.id), ["open"]);
  assert.equal(state.evidenceAndAssumptions.assumptions.length, 1);
  assert.ok(state.contentHash);

  project.confirmedProductState = state;
  markStageContentChanged(project, "SOLUTION");
  assert.equal(project.confirmedProductState.lifecycleStatus, "STALE");
});
