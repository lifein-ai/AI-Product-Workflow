import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { FigmaPromptService } from "../src/figma/figma-prompt-service.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";
import { buildConfirmedProductState } from "../src/workflow/confirmed-product-state.js";

test("Figma Prompt API returns a Codex prompt without executing Figma", async () => {
  const app = Fastify();
  const repo = new InMemoryProjectRepository();
  let calls = 0;
  const ai: AIProvider = {
    async generate(request) {
      calls += 1;
      const args = {
        schemaVersion: "figma-meta-plan.v1",
        analysis: { taskType: "活动页", pageTypes: ["Mobile"], coreCapabilities: ["Activity"] },
        selection: {
          baseId: "figma.base.v2",
          domainCapabilityIds: ["figma.capability.activity"],
          supportCapabilityIds: []
        },
        capabilityGaps: [], canAssemble: true, blockingIssues: []
      };
      return {
        text: "",
        calls: [{ callId: "figma-meta", name: request.toolNames[0], arguments: JSON.stringify(args) }],
        historyItems: []
      };
    }
  };
  const figmaPrompt = new FigmaPromptService(repo, ai);
  await app.register(projectRoutes, { repo, runtime: new RuntimeService(repo, ai), figmaPrompt });

  try {
    const project = createProjectRecord("Activity", "制作活动原型");
    project.workflow.stages.DISCOVERY.status = "CONFIRMED";
    project.workflow.stages.DISCOVERY.confirmedVersion = 0;
    project.workflow.stages.SOLUTION.status = "CONFIRMED";
    project.workflow.stages.SOLUTION.confirmedVersion = 0;
    project.workflow.activeStage = null;
    project.confirmedProductState = buildConfirmedProductState(project);
    project.artifacts.prd = {
      contentRevision: 1,
      lifecycleStatus: "CURRENT",
      reviewStatus: "CONFIRMED",
      sourceVersions: { discovery: 0, solution: 0, productSpecRevision: 0 },
      selectedPromptIds: ["prd.base", "prd.capability.activity"],
      promptHashes: {},
      generatedContent: "## 活动页\n\n- 展示活动信息。",
      currentContent: "## 活动页\n\n- 展示活动信息。",
      openQuestions: [], clarifications: [], generationNotes: [], blockingIssues: [],
      generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confirmedAt: new Date().toISOString()
    };
    project.artifacts.interaction = {
      contentRevision: 1,
      lifecycleStatus: "CURRENT",
      reviewStatus: "CONFIRMED",
      sourceVersions: {
        discovery: 0, solution: 0, productSpecRevision: 0,
        confirmedProductStateVersion: 1, confirmedProductStateHash: project.confirmedProductState.contentHash, prd: 1
      },
      promptHash: "interaction-prompt",
      generatedContent: "## Interaction Specification\n\n- 运营完成活动配置主流程。",
      currentContent: "## Interaction Specification\n\n- 运营完成活动配置主流程。",
      openQuestions: [], clarifications: [], generationNotes: [], blockingIssues: [],
      generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confirmedAt: new Date().toISOString()
    };
    const created = await repo.create(project);

    const generated = await app.inject({ method: "POST", url: `/projects/${created.id}/artifacts/figma-prompt/generate` });
    assert.equal(generated.statusCode, 200);
    assert.equal(calls, 1);
    assert.match(generated.json().artifact.currentContent, /# Codex Figma Prototype Task/);

    const confirmed = await app.inject({ method: "POST", url: `/projects/${created.id}/artifacts/figma-prompt/confirm` });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json().artifact.reviewStatus, "CONFIRMED");
  } finally {
    await app.close();
  }
});
