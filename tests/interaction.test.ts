import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider, ModelResponse } from "../src/ai/provider.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { InteractionService } from "../src/interaction/interaction-service.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";

function response(args: unknown): ModelResponse {
  return { text: "", calls: [{ callId: "interaction", name: "complete_interaction_generation", arguments: JSON.stringify(args) }], historyItems: [] };
}

function projectWithConfirmedPrd() {
  const project = createProjectRecord("Interaction", "Create a workflow");
  project.productSpec.solution.summary = "A confirmed workflow";
  project.productSpec.solution.coreSolution = "Guide the user through one canonical flow";
  project.productSpec.solution.keyMechanisms.push({ id: "flow", name: "Flow", description: "Canonical task flow" });
  project.productSpec.solution.scope.inScope.push("Main flow");
  project.productSpec.solution.scope.outOfScope.push("Visual redesign");
  project.productSpec.solution.keyRules.push({ id: "permission", rule: "Authorized users only" });
  project.productSpec.solution.mainProductFlow.push({ id: "start", step: "Start task" });
  project.productSpec.solution.tradeOffs.push({ id: "reuse", topic: "Reuse", decision: "Extend", rationale: "Lower risk" });
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.DISCOVERY.confirmedVersion = 1;
  project.workflow.stages.SOLUTION.status = "CONFIRMED";
  project.workflow.stages.SOLUTION.confirmedVersion = 2;
  project.workflow.activeStage = null;
  project.artifacts.prd = {
    contentRevision: 1,
    lifecycleStatus: "CURRENT",
    reviewStatus: "CONFIRMED",
    sourceVersions: { discovery: 1, solution: 2, productSpecRevision: 0 },
    selectedPromptIds: ["prd.base"], promptHashes: {},
    generatedContent: "## Main flow\n\n- User completes the task.",
    currentContent: "## Main flow\n\n- User completes the task.",
    openQuestions: [], clarifications: [], generationNotes: [], blockingIssues: [],
    generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confirmedAt: new Date().toISOString()
  };
  return project;
}

test("Interaction is a one-call Generation artifact and human edits invalidate Figma", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(projectWithConfirmedPrd());
  let calls = 0;
  const ai: AIProvider = {
    async generate(request) {
      calls += 1;
      assert.deepEqual(request.toolNames, ["complete_interaction_generation"]);
      assert.match(request.instructions, /Confirmed Product State/);
      assert.match(request.instructions, /Confirmed PRD Requirement Details/);
      return response({
        result: "GENERATED",
        interactionSpecificationMarkdown: "## Canonical Screen\n\n- The user follows the confirmed flow.",
        openQuestions: [], generationNotes: []
      });
    }
  };
  const service = new InteractionService(repo, ai);
  const generated = await service.generate(created.id);
  assert.equal(calls, 1);
  assert.equal(generated.artifact.reviewStatus, "DRAFT");
  assert.ok(generated.artifact.sourceVersions?.confirmedProductStateHash);

  const beforeEdit = (await repo.getById(created.id))!;
  beforeEdit.artifacts.figmaPrompt = {
    contentRevision: 1,
    lifecycleStatus: "CURRENT",
    reviewStatus: "CONFIRMED",
    sourceVersions: {
      discovery: 1, solution: 2, prd: 1, interaction: generated.artifact.contentRevision,
      confirmedProductStateVersion: generated.artifact.sourceVersions!.confirmedProductStateVersion,
      confirmedProductStateHash: generated.artifact.sourceVersions!.confirmedProductStateHash
    },
    selectedPromptIds: ["figma.base.v2"], promptHashes: {},
    generatedContent: "# Figma Prompt", currentContent: "# Figma Prompt", blockingIssues: [],
    generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confirmedAt: new Date().toISOString()
  };
  await repo.save(beforeEdit);
  const edited = await service.update(created.id, "## Reviewed Interaction\n\n- Confirmed flow.");
  assert.match(edited.artifact.currentContent!, /Reviewed/);
  assert.equal(edited.project.artifacts.figmaPrompt.lifecycleStatus, "STALE");
  const confirmed = await service.confirm(created.id);
  assert.equal(confirmed.artifact.reviewStatus, "CONFIRMED");
});
