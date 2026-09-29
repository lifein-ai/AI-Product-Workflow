import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";
import { stageRegistry } from "../src/workflow/stage-registry.js";

test("Solution API starts only after Discovery confirmation and cannot confirm before Ready", async () => {
  const app = Fastify();
  const repo = new InMemoryProjectRepository();
  const project = await repo.create(createProjectRecord("PK", "主播 PK"));
  const ai: AIProvider = { async generate() {
    const args = {
      expectedRevision: 0,
      assistantResponse: "这是基于 Discovery 的初始方案。",
      operations: [],
      readyEvaluation: {
        criteria: stageRegistry.SOLUTION.exitCriteriaIds.map(criterionId => ({ criterionId, status: "MISSING", reason: "待讨论" })),
        blockingUnknownIds: [], summary: "Not ready"
      }
    };
    return {
      text: "", calls: [{ callId: "solution-start", name: "complete_solution_turn", arguments: JSON.stringify(args) }],
      historyItems: [{ type: "function_call", call_id: "solution-start" }]
    };
  } };
  await app.register(projectRoutes, { repo, runtime: new RuntimeService(repo, ai) });
  try {
    assert.equal((await app.inject({ method: "POST", url: `/projects/${project.id}/stages/solution/start`, payload: {} })).statusCode, 409);
    const confirmed = (await repo.getById(project.id))!;
    confirmed.workflow.stages.DISCOVERY.status = "CONFIRMED";
    confirmed.workflow.stages.DISCOVERY.confirmedVersion = 0;
    await repo.save(confirmed);
    const started = await app.inject({
      method: "POST", url: `/projects/${project.id}/stages/solution/start`, headers: { "x-request-id": "solution-api-start" }, payload: {}
    });
    assert.equal(started.statusCode, 200);
    assert.equal(started.headers["x-request-id"], "solution-api-start");
    assert.equal(started.json().project.workflow.activeStage, "SOLUTION");
    assert.equal(started.json().project.workflow.stages.SOLUTION.status, "IN_PROGRESS");
    assert.equal((await app.inject({ method: "POST", url: `/projects/${project.id}/stages/solution/confirm`, payload: {} })).statusCode, 409);
  } finally {
    await app.close();
  }
});
