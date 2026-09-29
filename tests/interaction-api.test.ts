import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { InteractionService } from "../src/interaction/interaction-service.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";

test("Interaction API generates, edits, and confirms a Generation Layer artifact", async () => {
  const app = Fastify();
  const repo = new InMemoryProjectRepository();
  const ai: AIProvider = {
    async generate(request) {
      return {
        text: "",
        calls: [{
          callId: "interaction",
          name: request.toolNames[0],
          arguments: JSON.stringify({
            result: "GENERATED",
            interactionSpecificationMarkdown: "## Core Flow\n\n- User completes the confirmed flow.",
            openQuestions: [], generationNotes: []
          })
        }],
        historyItems: []
      };
    }
  };
  await app.register(projectRoutes, {
    repo,
    runtime: new RuntimeService(repo, ai),
    interaction: new InteractionService(repo, ai)
  });
  try {
    const project = createProjectRecord("Interaction API", "Create a flow");
    project.workflow.stages.DISCOVERY.status = "CONFIRMED";
    project.workflow.stages.DISCOVERY.confirmedVersion = 0;
    project.workflow.stages.SOLUTION.status = "CONFIRMED";
    project.workflow.stages.SOLUTION.confirmedVersion = 0;
    project.workflow.activeStage = null;
    project.artifacts.prd = {
      contentRevision: 1, lifecycleStatus: "CURRENT", reviewStatus: "CONFIRMED",
      sourceVersions: { discovery: 0, solution: 0, productSpecRevision: 0 },
      selectedPromptIds: ["prd.base"], promptHashes: {},
      generatedContent: "## Requirement", currentContent: "## Requirement",
      openQuestions: [], clarifications: [], generationNotes: [], blockingIssues: [],
      generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confirmedAt: new Date().toISOString()
    };
    const created = await repo.create(project);
    const generated = await app.inject({ method: "POST", url: `/projects/${created.id}/artifacts/interaction/generate` });
    assert.equal(generated.statusCode, 200);
    assert.equal(generated.json().artifact.reviewStatus, "DRAFT");

    const edited = await app.inject({
      method: "PATCH",
      url: `/projects/${created.id}/artifacts/interaction`,
      payload: { content: "## Reviewed Interaction" }
    });
    assert.equal(edited.statusCode, 200);
    const confirmed = await app.inject({ method: "POST", url: `/projects/${created.id}/artifacts/interaction/confirm` });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json().artifact.reviewStatus, "CONFIRMED");
  } finally {
    await app.close();
  }
});
