import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { DecisionMemoryService, mergeDecisionCandidates } from "../src/decisions/decision-memory-service.js";
import type { DecisionCandidate } from "../src/decisions/schemas.js";
import { createProjectRecord } from "../src/domain/factories.js";
import type { ConversationMessage, ProjectRecord } from "../src/domain/types.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import {
  MANUAL_BRIDGE_END,
  MANUAL_BRIDGE_START,
  ManualBridgeService
} from "../src/runtime/manual-bridge-service.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";
import { stageRegistry } from "../src/workflow/stage-registry.js";

function messages(...content: string[]): ConversationMessage[] {
  return content.map((text, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: text,
    createdAt: new Date(2026, 0, index + 1).toISOString(),
    stage: "SOLUTION"
  }));
}

function candidate(overrides: Partial<DecisionCandidate> = {}): DecisionCandidate {
  return {
    action: "CREATE",
    targetDecisionId: null,
    feature: "PK",
    topic: "PK Duration",
    decision: "180 seconds",
    reason: null,
    alternatives: [],
    importance: 2,
    strength: "EXPLICIT",
    status: "ACTIVE",
    sourceMessageIds: ["message-1"],
    ...overrides
  };
}

function projectWithMessages(...content: string[]): ProjectRecord {
  const project = createProjectRecord("Decision Memory", "Design a PK flow");
  project.workflow.activeStage = "SOLUTION";
  project.messages = messages(...content);
  return project;
}

test("Case 1: an explicit confirmation becomes one ACTIVE EXPLICIT decision", () => {
  const project = projectWithMessages("那 PK 就定180秒。", "收到。");
  const result = mergeDecisionCandidates(project, [candidate()], project.messages);
  assert.equal(result.created, 1);
  assert.equal(project.productSpec.decisions[0].status, "ACTIVE");
  assert.equal(project.productSpec.decisions[0].strength, "EXPLICIT");
  assert.deepEqual(project.productSpec.decisions[0].sourceMessageIds, ["message-1"]);
});

test("Case 2: an uncertain candidate is stored as DEFERRED, never ACTIVE", () => {
  const project = projectWithMessages("PK要不要考虑300秒？", "可以评估，但还没定。");
  mergeDecisionCandidates(project, [candidate({
    decision: "Consider 300 seconds",
    strength: "TENTATIVE",
    status: "ACTIVE"
  })], project.messages);
  assert.equal(project.productSpec.decisions[0].status, "DEFERRED");
});

test("Case 3: an unaccepted assistant suggestion can be explicitly ignored", () => {
  const project = projectWithMessages("先不用定。", "建议 V1 不做随机匹配。");
  const result = mergeDecisionCandidates(project, [candidate({
    action: "IGNORE",
    topic: "Random Matching Scope",
    decision: "V1 excludes random matching"
  })], project.messages);
  assert.equal(result.ignored, 1);
  assert.equal(project.productSpec.decisions.length, 0);
});

test("Case 4: intermediate values remain alternatives to one final decision", () => {
  const project = projectWithMessages("60秒太长，30秒太短，就定45秒。", "已确认45秒。");
  mergeDecisionCandidates(project, [candidate({
    topic: "Full Seats Boost Duration",
    decision: "45 seconds",
    alternatives: [
      { option: "60 seconds", rejectionReason: "Too long" },
      { option: "30 seconds", rejectionReason: "Too short" }
    ]
  })], project.messages);
  assert.equal(project.productSpec.decisions.length, 1);
  assert.deepEqual(project.productSpec.decisions[0].alternatives?.map(item => item.option), ["60 seconds", "30 seconds"]);
});

test("Case 5: a changed core choice supersedes the prior decision", () => {
  const project = projectWithMessages("先定60秒。", "收到。", "还是改45秒。", "已修改。");
  mergeDecisionCandidates(project, [candidate({
    topic: "Full Seats Boost Duration",
    decision: "60 seconds",
    sourceMessageIds: ["message-1"]
  })], project.messages);
  const old = project.productSpec.decisions[0];
  const result = mergeDecisionCandidates(project, [candidate({
    action: "SUPERSEDE",
    targetDecisionId: old.id,
    topic: "Full Seats Boost Duration",
    decision: "45 seconds",
    sourceMessageIds: ["message-3"]
  })], project.messages);
  assert.equal(result.superseded, 1);
  assert.equal(old.status, "SUPERSEDED");
  assert.equal(project.productSpec.decisions[1].supersedesDecisionId, old.id);
  assert.equal(old.supersededBy, project.productSpec.decisions[1].id);
});

test("Case 6: repeated wording with no new information is ignored", () => {
  const project = projectWithMessages("PK 就定180秒。", "收到。", "PK现在就是180秒。", "是的。");
  mergeDecisionCandidates(project, [candidate({ sourceMessageIds: ["message-1"] })], project.messages);
  const existing = project.productSpec.decisions[0];
  const result = mergeDecisionCandidates(project, [candidate({
    action: "CREATE",
    targetDecisionId: existing.id,
    sourceMessageIds: ["message-3"]
  })], project.messages);
  assert.equal(result.ignored, 1);
  assert.equal(project.productSpec.decisions.length, 1);
});

test("Cases 7 and 8: Provider and Manual Bridge turns are available to manual Decision Memory scans", async () => {
  const repo = new InMemoryProjectRepository();
  let extractionCalls = 0;
  const ai: AIProvider = {
    async generate(request) {
      const toolName = request.toolNames[0];
      if (toolName === "extract_decisions") {
        extractionCalls += 1;
        const payload = JSON.parse((request.input[0] as { content: string }).content) as { conversation: ConversationMessage[] };
        const lastUser = [...payload.conversation].reverse().find(message => message.role === "user")!;
        const args = { decisions: [candidate({
          topic: extractionCalls === 1 ? "Provider Topic" : "Manual Topic",
          decision: extractionCalls === 1 ? "Provider decision" : "Manual decision",
          sourceMessageIds: [lastUser.id]
        })] };
        return { text: "", calls: [{ callId: `extract-${extractionCalls}`, name: toolName, arguments: JSON.stringify(args) }], historyItems: [] };
      }
      const args = {
        expectedRevision: 0,
        assistantResponse: "继续讨论。",
        operations: [],
        readyEvaluation: {
          criteria: stageRegistry.DISCOVERY.exitCriteriaIds.map(criterionId => ({ criterionId, status: "MISSING", reason: "继续讨论" })),
          blockingUnknownIds: [],
          summary: "继续讨论"
        }
      };
      return { text: "", calls: [{ callId: "turn", name: toolName, arguments: JSON.stringify(args) }], historyItems: [] };
    }
  };
  const app = Fastify();
  const bridge = new ManualBridgeService(repo);
  const decisionMemory = new DecisionMemoryService(repo, ai, 2);
  await app.register(projectRoutes, { repo, runtime: new RuntimeService(repo, ai), manualBridge: bridge, decisionMemory });
  try {
    const created = await app.inject({ method: "POST", url: "/projects", payload: { name: "Both modes", initialRequirement: "Test both modes" } });
    const id = created.json().id as string;
    const providerTurn = await app.inject({ method: "POST", url: `/projects/${id}/messages`, payload: { content: "Provider input" } });
    assert.equal(providerTurn.statusCode, 200);
    assert.equal(providerTurn.json().decisionScan, undefined);
    assert.equal(extractionCalls, 0);
    const providerScan = await app.inject({ method: "POST", url: `/projects/${id}/decisions/scan`, payload: {} });
    assert.equal(providerScan.json().decisionScan.status, "SCANNED");
    assert.equal(providerScan.json().project.productSpec.decisions[0].topic, "Provider Topic");

    const prepared = await app.inject({ method: "POST", url: `/projects/${id}/manual-bridge/prompt`, payload: { content: "Manual input" } });
    const turn = prepared.json();
    const manualResponse = `Manual answer\n\n${MANUAL_BRIDGE_START}\n${JSON.stringify({
      schemaVersion: "manual-bridge-turn.v1",
      expectedRevision: turn.expectedRevision,
      operations: [],
      readyEvaluation: {
        criteria: stageRegistry.DISCOVERY.exitCriteriaIds.map(criterionId => ({ criterionId, status: "MISSING", reason: "继续讨论" })),
        blockingUnknownIds: [],
        summary: "继续讨论"
      }
    })}\n${MANUAL_BRIDGE_END}`;
    const manualTurn = await app.inject({
      method: "POST",
      url: `/projects/${id}/manual-bridge/apply`,
      payload: { ...turn, response: manualResponse }
    });
    assert.equal(manualTurn.statusCode, 200);
    assert.equal(manualTurn.json().decisionScan, undefined);
    const manualScan = await app.inject({ method: "POST", url: `/projects/${id}/decisions/scan`, payload: {} });
    assert.equal(manualScan.json().decisionScan.status, "SCANNED");
    assert.equal(manualScan.json().project.productSpec.decisions.some((decision: { topic: string }) => decision.topic === "Manual Topic"), true);
    assert.equal(extractionCalls, 2);

    const noNewMessages = await app.inject({ method: "POST", url: `/projects/${id}/decisions/scan`, payload: {} });
    assert.equal(noNewMessages.statusCode, 200);
    assert.equal(noNewMessages.json().decisionScan.status, "SKIPPED");
  } finally {
    await app.close();
  }
});

test("invalid extractor output records failure without advancing the checkpoint", async () => {
  const repo = new InMemoryProjectRepository();
  const project = projectWithMessages("A", "B");
  await repo.create(project);
  const ai: AIProvider = { async generate() { return { text: "", calls: [], historyItems: [] }; } };
  const result = await new DecisionMemoryService(repo, ai, 2).scanIfNeeded(project.id);
  const saved = await repo.getById(project.id);
  assert.equal(result.status, "FAILED");
  assert.equal(saved?.decisionMemory.status, "FAILED");
  assert.equal(saved?.decisionMemory.lastScannedMessageId, undefined);
  assert.equal(saved?.messages.length, 2);
});

test("long conversations scan a bounded window with overlap and only bounded relevant decisions", async () => {
  const repo = new InMemoryProjectRepository();
  const project = projectWithMessages(...Array.from({ length: 30 }, (_, index) => `message ${index + 1}`));
  for (let index = 0; index < 20; index += 1) {
    mergeDecisionCandidates(project, [candidate({
      topic: `Topic ${index}`,
      decision: `Decision ${index}`,
      sourceMessageIds: ["message-1"]
    })], project.messages);
  }
  await repo.create(project);
  const requests: Parameters<AIProvider["generate"]>[0][] = [];
  const ai: AIProvider = { async generate(request) {
    requests.push(request);
    return {
      text: "",
      calls: [{ callId: "extract", name: "extract_decisions", arguments: JSON.stringify({ decisions: [] }) }],
      historyItems: []
    };
  } };
  const service = new DecisionMemoryService(repo, ai, 6);

  const first = await service.scanNow(project.id);
  const firstPayload = JSON.parse((requests[0].input[0] as { content: string }).content);
  assert.equal(first.scannedMessageCount, 12);
  assert.equal(first.remainingMessageCount, 18);
  assert.equal(firstPayload.conversation.length, 12);
  assert.ok(firstPayload.existingDecisions.length <= 12);
  assert.equal(requests[0].maxRetries, 2);
  assert.equal((await repo.getById(project.id))?.decisionMemory.status, "PENDING");

  const second = await service.scanNow(project.id);
  const secondPayload = JSON.parse((requests[1].input[0] as { content: string }).content);
  assert.equal(second.scannedMessageCount, 12);
  assert.equal(second.remainingMessageCount, 6);
  assert.equal(secondPayload.conversation.length, 16);
  assert.equal((await repo.getById(project.id))?.decisionMemory.lastScannedMessageId, "message-24");
});
