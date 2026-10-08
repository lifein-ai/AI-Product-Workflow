import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import {
  MANUAL_BRIDGE_END,
  MANUAL_BRIDGE_START,
  ManualBridgeService
} from "../src/runtime/manual-bridge-service.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";
import { stageRegistry } from "../src/workflow/stage-registry.js";

const unusedAI: AIProvider = { async generate() { throw new Error("Provider must not be called by Manual Bridge"); } };

function responseFor(
  stage: "DISCOVERY" | "SOLUTION",
  revision: number,
  answer = "请补充最关键的目标用户场景。",
  operations: unknown[] = []
) {
  return `${answer}\n\n${MANUAL_BRIDGE_START}\n${JSON.stringify({
    schemaVersion: "manual-bridge-turn.v1",
    expectedRevision: revision,
    operations,
    readyEvaluation: {
      criteria: stageRegistry[stage].exitCriteriaIds.map(criterionId => ({
        criterionId,
        status: "MISSING",
        reason: "仍需补充"
      })),
      blockingUnknownIds: [],
      summary: "信息不足，继续讨论"
    }
  })}\n${MANUAL_BRIDGE_END}`;
}

test("Manual Bridge prompt reuses canonical context and exposes a deterministic response contract", async () => {
  const repo = new InMemoryProjectRepository();
  const project = await repo.create(createProjectRecord("Bridge", "帮助主播提高互动"));
  const bridge = new ManualBridgeService(repo);

  const result = await bridge.preparePrompt(project.id, { content: "主要面向新主播" });

  assert.equal(result.stage, "DISCOVERY");
  assert.equal(result.expectedRevision, 0);
  assert.match(result.prompt, /CURRENT STRUCTURED CONTEXT/);
  assert.match(result.prompt, /主要面向新主播/);
  assert.match(result.prompt, /ChatGPT Memory/);
  assert.match(result.prompt, /current project facts/i);
  assert.match(result.prompt, /manual-bridge-turn\.v1/);
  assert.doesNotMatch(result.prompt, /originally written for function calling|replace any instruction to call|complete_discovery_turn/i);
  assert.match(result.prompt, new RegExp(MANUAL_BRIDGE_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((await repo.getById(project.id))?.messages.length, 0);
});

test("Manual Bridge applies a valid pasted response through the existing turn executor", async () => {
  const repo = new InMemoryProjectRepository();
  const project = await repo.create(createProjectRecord("Bridge", "帮助主播提高互动"));
  const bridge = new ManualBridgeService(repo);
  const prompt = await bridge.preparePrompt(project.id, { content: "主要面向新主播" });

  const result = await bridge.applyResponse(project.id, {
    stage: prompt.stage,
    kind: prompt.kind,
    expectedRevision: prompt.expectedRevision,
    expectedRecordVersion: prompt.expectedRecordVersion,
    turnToken: prompt.turnToken,
    userMessage: prompt.userMessage,
    response: responseFor("DISCOVERY", 0)
  });

  assert.equal(result.reply, "请补充最关键的目标用户场景。");
  assert.equal(result.project.messages.length, 2);
  assert.equal(result.project.messages[0].content, "主要面向新主播");
  assert.equal(result.project.messages[1].content, result.reply);
  assert.equal(result.project.workflow.stages.DISCOVERY.status, "IN_PROGRESS");
});

test("Manual Bridge rejects malformed and stale responses without saving messages", async () => {
  const repo = new InMemoryProjectRepository();
  const project = await repo.create(createProjectRecord("Bridge", "帮助主播提高互动"));
  const bridge = new ManualBridgeService(repo);
  const prompt = await bridge.preparePrompt(project.id, { content: "主要面向新主播" });

  await assert.rejects(() => bridge.applyResponse(project.id, {
    stage: prompt.stage,
    kind: prompt.kind,
    expectedRevision: prompt.expectedRevision,
    expectedRecordVersion: prompt.expectedRecordVersion,
    turnToken: prompt.turnToken,
    userMessage: prompt.userMessage,
    response: "只有普通回答，没有结构化块"
  }), /missing the Manual Bridge update block/);
  await assert.rejects(() => bridge.applyResponse(project.id, {
    stage: prompt.stage,
    kind: prompt.kind,
    expectedRevision: prompt.expectedRevision,
    expectedRecordVersion: prompt.expectedRecordVersion,
    turnToken: prompt.turnToken,
    userMessage: prompt.userMessage,
    response: responseFor("DISCOVERY", 1)
  }), /Stale Product Spec revision/);
  assert.equal((await repo.getById(project.id))?.messages.length, 0);
});

test("Manual Bridge rejects forged tokens and partial operation batches", async () => {
  const repo = new InMemoryProjectRepository();
  const project = await repo.create(createProjectRecord("Bridge validation", "验证整轮应用"));
  const bridge = new ManualBridgeService(repo);
  const prompt = await bridge.preparePrompt(project.id, { content: "更新问题并关闭旧问题" });
  const forgedToken = createHash("sha256")
    .update(JSON.stringify({
      projectId: project.id,
      stage: prompt.stage,
      kind: prompt.kind,
      revision: prompt.expectedRevision,
      recordVersion: prompt.expectedRecordVersion,
      userMessage: prompt.userMessage
    }))
    .digest("hex");

  await assert.rejects(() => bridge.applyResponse(project.id, {
    ...prompt,
    turnToken: forgedToken,
    response: responseFor("DISCOVERY", prompt.expectedRevision)
  }), /metadata does not match/);

  await assert.rejects(() => bridge.applyResponse(project.id, {
    stage: prompt.stage,
    kind: prompt.kind,
    expectedRevision: prompt.expectedRevision,
    expectedRecordVersion: prompt.expectedRecordVersion,
    turnToken: prompt.turnToken,
    userMessage: prompt.userMessage,
    response: responseFor("DISCOVERY", prompt.expectedRevision, "已处理。", [
      {
        kind: "update_product_spec",
        operations: [{ op: "REPLACE", path: "discovery.problem", value: { statement: "不应保存" } }],
        summary: "valid update"
      },
      { kind: "manage_open_question", action: "RESOLVE" }
    ])
  }), /RESOLVE requires questionId/);

  const unchanged = await repo.getById(project.id);
  assert.equal(unchanged?.productSpec.discovery.problem, undefined);
  assert.equal(unchanged?.productSpec.version.revision, 0);
  assert.equal(unchanged?.recordVersion, 0);
  assert.equal(unchanged?.messages.length, 0);
});

test("Manual Bridge keeps Solution start atomic until the pasted kickoff response validates", async () => {
  const repo = new InMemoryProjectRepository();
  const seed = createProjectRecord("Bridge Solution", "形成产品方案");
  seed.workflow.stages.DISCOVERY.status = "CONFIRMED";
  seed.workflow.stages.DISCOVERY.confirmedVersion = seed.workflow.stages.DISCOVERY.contentVersion;
  const project = await repo.create(seed);
  const bridge = new ManualBridgeService(repo);

  const prompt = await bridge.preparePrompt(project.id, { kind: "SOLUTION_START" });
  assert.equal(prompt.stage, "SOLUTION");
  assert.equal((await repo.getById(project.id))?.workflow.stages.SOLUTION.status, "NOT_STARTED");

  const result = await bridge.applyResponse(project.id, {
    stage: prompt.stage,
    kind: prompt.kind,
    expectedRevision: prompt.expectedRevision,
    expectedRecordVersion: prompt.expectedRecordVersion,
    turnToken: prompt.turnToken,
    userMessage: prompt.userMessage,
    response: responseFor("SOLUTION", prompt.expectedRevision, "先给出初始方案，再确认关键取舍。")
  });
  assert.equal(result.project.workflow.activeStage, "SOLUTION");
  assert.equal(result.project.workflow.stages.SOLUTION.status, "IN_PROGRESS");
  assert.equal(result.project.messages.length, 1);
  assert.equal(result.project.messages[0].role, "assistant");
  assert.equal(result.project.messages[0].stage, "SOLUTION");
});

test("Manual Bridge API supports prompt and apply without invoking the configured provider", async () => {
  const app = Fastify();
  const repo = new InMemoryProjectRepository();
  const bridge = new ManualBridgeService(repo);
  await app.register(projectRoutes, {
    repo,
    runtime: new RuntimeService(repo, unusedAI),
    manualBridge: bridge
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Bridge API", initialRequirement: "测试手动桥接" }
    });
    const id = created.json().id as string;
    const prepared = await app.inject({
      method: "POST",
      url: `/projects/${id}/manual-bridge/prompt`,
      payload: { content: "第一轮" }
    });
    assert.equal(prepared.statusCode, 200);
    const turn = prepared.json();
    const applied = await app.inject({
      method: "POST",
      url: `/projects/${id}/manual-bridge/apply`,
      payload: {
        stage: turn.stage,
        kind: turn.kind,
        expectedRevision: turn.expectedRevision,
        expectedRecordVersion: turn.expectedRecordVersion,
        turnToken: turn.turnToken,
        userMessage: turn.userMessage,
        response: responseFor("DISCOVERY", turn.expectedRevision)
      }
    });
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json().project.messages.length, 2);

    const invalid = await app.inject({
      method: "POST",
      url: `/projects/${id}/manual-bridge/apply`,
      payload: { ...turn, response: "invalid" }
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
  }
});

