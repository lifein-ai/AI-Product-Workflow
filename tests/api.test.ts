import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";
import { applyReadyEvaluation } from "../src/workflow/state-machine.js";
import { stageRegistry } from "../src/workflow/stage-registry.js";

test("Discovery API creates, reads, converses, and confirms with correct guards", async () => {
  const app = Fastify();
  const repo = new InMemoryProjectRepository();
  const ai: AIProvider = { async generate() {
    const args = {
      expectedRevision: 0,
      assistantResponse: "请说明目标用户。",
      operations: [],
      readyEvaluation: {
        criteria: stageRegistry.DISCOVERY.exitCriteriaIds.map(criterionId => ({ criterionId, status: "MISSING", reason: "test" })),
        blockingUnknownIds: [],
        summary: "test"
      }
    };
    return {
      text: "",
      calls: [{ callId: "api-turn", name: "complete_discovery_turn", arguments: JSON.stringify(args) }],
      historyItems: [{ type: "function_call", call_id: "api-turn" }]
    };
  } };
  await app.register(projectRoutes, { repo, runtime: new RuntimeService(repo, ai) });
  try {
    const invalid = await app.inject({ method: "POST", url: "/projects", payload: { name: "" } });
    assert.equal(invalid.statusCode, 400);
    const created = await app.inject({ method: "POST", url: "/projects", payload: {
      name: "PK", initialRequirement: "主播 PK"
    } });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as string;
    assert.equal((await app.inject({ method: "GET", url: `/projects/${id}` })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `/projects/${id}/stages/discovery/confirm` })).statusCode, 409);
    const message = await app.inject({
      method: "POST",
      url: `/projects/${id}/messages`,
      headers: { "x-request-id": "request-api-test" },
      payload: { content: "希望提高互动" }
    });
    assert.equal(message.statusCode, 200);
    assert.equal(message.headers["x-request-id"], "request-api-test");
    assert.equal(message.json().reply, "请说明目标用户。");
    const project = (await repo.getById(id))!;
    assert.equal(project.messages.length, 2);
    applyReadyEvaluation(project, "DISCOVERY", {
      criteria: [], blockingUnknownIds: [], result: "READY", summary: "test route", evaluatedContentVersion: 0,
      dependencySnapshot: {}
    });
    await repo.save(project);
    const confirmed = await app.inject({ method: "POST", url: `/projects/${id}/stages/discovery/confirm` });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json().stages.DISCOVERY.status, "CONFIRMED");
    assert.equal((await app.inject({ method: "POST", url: `/projects/${id}/messages`, payload: { content: "再聊聊" } })).statusCode, 409);
    assert.equal((await app.inject({ method: "GET", url: "/projects/missing" })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("Provider connection failures return a retryable gateway error without saving the turn", async () => {
  const app = Fastify();
  const repo = new InMemoryProjectRepository();
  const ai: AIProvider = { async generate() { throw new Error("ModelFlare connection failed"); } };
  await app.register(projectRoutes, { repo, runtime: new RuntimeService(repo, ai) });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Connection failure", initialRequirement: "Test retry safety" }
    });
    const id = created.json().id as string;
    const failed = await app.inject({ method: "POST", url: `/projects/${id}/messages`, payload: { content: "First turn" } });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().error, "ModelFlare connection failed");
    assert.equal((await repo.getById(id))?.messages.length, 0);
  } finally {
    await app.close();
  }
});
