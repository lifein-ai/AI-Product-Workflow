import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider } from "../src/ai/provider.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { FigmaPromptService } from "../src/figma/figma-prompt-service.js";
import { InteractionService } from "../src/interaction/interaction-service.js";
import { PrdService } from "../src/prd/prd-service.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";

test("Confirmed Product State drives the complete PRD to Interaction to Figma Generation chain", async () => {
  const repo = new InMemoryProjectRepository();
  const project = createProjectRecord("Generation chain", "Let operators configure an activity");
  project.productSpec.discovery.problem = { statement: "Configuration is fragmented" };
  project.productSpec.solution.summary = "One activity workbench";
  project.productSpec.solution.coreSolution = "A structured draft, validation, preview, and publish flow";
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.DISCOVERY.confirmedVersion = 1;
  project.workflow.stages.SOLUTION.status = "CONFIRMED";
  project.workflow.stages.SOLUTION.confirmedVersion = 2;
  project.workflow.activeStage = null;
  const created = await repo.create(project);
  const calls: string[] = [];
  const ai: AIProvider = {
    async generate(request) {
      const name = request.toolNames[0];
      calls.push(name);
      const args = name === "complete_prd_meta_analysis"
        ? {
            schemaVersion: "prd-meta-plan.v1",
            analysis: { requirementType: "Activity", domains: ["Activity"], coreObjects: ["Draft"], roles: ["Operator"], goal: "Create an activity" },
            selection: { baseId: "prd.base", domainCapabilityIds: [], generalCapabilityIds: ["prd.capability.activity"], supportCapabilityIds: [], projectPromptIds: [] },
            capabilityGaps: [], canGenerate: true, blockingIssues: []
          }
        : name === "complete_prd_generation"
          ? { result: "GENERATED", requirementDetailsMarkdown: "## Activity\n\n- Operator configures and publishes a draft.", openQuestions: [], generationNotes: [] }
          : name === "complete_interaction_generation"
            ? { result: "GENERATED", interactionSpecificationMarkdown: "## Activity Workbench\n\n- Draft → Validate → Preview → Publish.", openQuestions: [], generationNotes: [] }
            : {
                schemaVersion: "figma-meta-plan.v1",
                analysis: { taskType: "Backend activity prototype", pageTypes: ["Workbench"], coreCapabilities: ["Draft", "Publish"] },
                selection: { baseId: "figma.base.v2", domainCapabilityIds: ["figma.capability.backend"], supportCapabilityIds: [] },
                capabilityGaps: [], canAssemble: true, blockingIssues: []
              };
      return { text: "", calls: [{ callId: name, name, arguments: JSON.stringify(args) }], historyItems: [] };
    }
  };

  const prd = new PrdService(repo, ai);
  await prd.generate(created.id);
  await prd.confirm(created.id);
  const interaction = new InteractionService(repo, ai);
  await interaction.generate(created.id);
  await interaction.confirm(created.id);
  const figma = await new FigmaPromptService(repo, ai).generate(created.id);

  assert.deepEqual(calls, [
    "complete_prd_meta_analysis",
    "complete_prd_generation",
    "complete_interaction_generation",
    "complete_figma_meta_analysis"
  ]);
  assert.equal(figma.artifact.lifecycleStatus, "CURRENT");
  assert.match(figma.artifact.currentContent!, /Activity Workbench/);
  assert.equal(figma.project.confirmedProductState?.lifecycleStatus, "CURRENT");
});
