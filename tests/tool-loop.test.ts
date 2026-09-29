import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider, ModelResponse } from "../src/ai/provider.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { runToolLoop } from "../src/runtime/tool-loop.js";
import { stageRegistry } from "../src/workflow/stage-registry.js";

function readyEvaluation(status: "MISSING" | "NOT_APPLICABLE" = "MISSING") {
  return {
    criteria: stageRegistry.DISCOVERY.exitCriteriaIds.map(criterionId => ({ criterionId, status, reason: "test" })),
    blockingUnknownIds: [],
    summary: "test evaluation"
  };
}

function turnResponse(args: Record<string, unknown>, callId = "turn"): ModelResponse {
  return {
    text: "",
    historyItems: [{ type: "function_call", call_id: callId, name: "complete_discovery_turn", arguments: JSON.stringify(args) }],
    calls: [{ callId, name: "complete_discovery_turn", arguments: JSON.stringify(args) }]
  };
}

test("normal Discovery turn uses one model call for response, operations, and Ready evaluation", async () => {
  const project = createProjectRecord("PK", "主播 PK");
  const seen: Array<{ input: unknown[]; toolNames: string[] }> = [];
  const ai: AIProvider = { async generate(request) {
    seen.push({ input: [...request.input], toolNames: [...request.toolNames] });
    return turnResponse({
      expectedRevision: 0,
      assistantResponse: "已记录目标。当前主要阻力是什么？",
      operations: [
        { kind: "update_product_spec", summary: "goal", operations: [{ op: "REPLACE", path: "discovery.goals.primary", value: "提高 PK 参与" }] },
        {
          kind: "manage_open_question", action: "CREATE", question: "主播当前不使用 PK 的主要阻力是什么？",
          impact: "决定方案方向", blocking: true, resolutionMethod: "STAKEHOLDER_CONFIRMATION"
        }
      ],
      readyEvaluation: readyEvaluation()
    });
  } };

  const reply = await runToolLoop(project, "我想提高主播 PK 参与", ai, "request-normal");
  assert.equal(reply, "已记录目标。当前主要阻力是什么？");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].toolNames, ["complete_discovery_turn"]);
  assert.equal(project.productSpec.discovery.goals.primary, "提高 PK 参与");
  assert.equal(project.productSpec.openQuestions[0].blocking, true);
  assert.equal(project.workflow.stages.DISCOVERY.status, "IN_PROGRESS");
});

test("stage turn accepts a missing descriptive update summary", async () => {
  const project = createProjectRecord("Summary adapter", "Clarify the goal");
  let calls = 0;
  const provider: AIProvider = { async generate() {
    calls += 1;
    return turnResponse({
      expectedRevision: 0,
      assistantResponse: "Goal captured.",
      operations: [{
        kind: "update_product_spec",
        operations: [{ op: "REPLACE", path: "discovery.goals.primary", value: "Reduce errors" }]
      }],
      readyEvaluation: readyEvaluation()
    });
  } };

  const reply = await runToolLoop(project, "Reduce errors", provider);

  assert.equal(reply, "Goal captured.");
  assert.equal(project.productSpec.discovery.goals.primary, "Reduce errors");
  assert.equal(calls, 1);
});

test("new Decision ID can be referenced by Product Spec in the same model call", async () => {
  const project = createProjectRecord("PK", "主播 PK");
  let calls = 0;
  const ai: AIProvider = { async generate() {
    calls += 1;
    return turnResponse({
      expectedRevision: 0,
      assistantResponse: "已记录按假设推进的决定。",
      operations: [
        {
          kind: "record_decision", reference: "friction-basis", decision: "先按找对手困难推进",
          rationale: ["用户明确接受"], affectedPaths: ["discovery.behaviorChange"]
        },
        {
          kind: "update_product_spec", summary: "accepted assumption", operations: [{
            op: "REPLACE", path: "discovery.behaviorChange", value: {
              targetBehavior: "提高 PK 参与",
              basis: {
                type: "ACCEPTED_ASSUMPTION", assumption: "找对手困难", evidenceStatus: "UNVALIDATED",
                decisionId: "$decision:friction-basis", validationIntent: "比较对手曝光前后的成局率"
              }
            }
          }]
        }
      ],
      readyEvaluation: readyEvaluation()
    });
  } };

  await runToolLoop(project, "先按找对手困难这个假设推进", ai);
  assert.equal(calls, 1);
  assert.equal(project.productSpec.decisions.length, 1);
  assert.equal(project.productSpec.discovery.behaviorChange?.basis.type, "ACCEPTED_ASSUMPTION");
  if (project.productSpec.discovery.behaviorChange?.basis.type !== "ACCEPTED_ASSUMPTION") assert.fail("expected accepted assumption");
  assert.equal(project.productSpec.discovery.behaviorChange.basis.decisionId, project.productSpec.decisions[0].id);
});

test("operation validation conflict permits one repair call and rolls back the failed batch", async () => {
  const project = createProjectRecord("PK", "主播 PK");
  const seen: unknown[][] = [];
  const responses = [
    turnResponse({
      expectedRevision: 0,
      assistantResponse: "invalid",
      operations: [
        { kind: "update_product_spec", summary: "partial", operations: [{ op: "REPLACE", path: "discovery.problem", value: { statement: "不应保留" } }] },
        { kind: "update_product_spec", summary: "invalid", operations: [{ op: "REPLACE", path: "solution.foo", value: "bad" }] }
      ],
      readyEvaluation: readyEvaluation()
    }, "bad"),
    turnResponse({ expectedRevision: 0, assistantResponse: "已修正。", operations: [], readyEvaluation: readyEvaluation() }, "fixed")
  ];
  const ai: AIProvider = { async generate(request) {
    seen.push([...request.input]);
    return responses.shift()!;
  } };

  const reply = await runToolLoop(project, "修复测试", ai);
  assert.equal(reply, "已修正。");
  assert.equal(seen.length, 2);
  assert.equal(project.productSpec.discovery.problem, undefined);
  assert.equal(project.productSpec.version.revision, 0);
  assert.ok(seen[1].some(item => typeof item === "object" && item !== null && "type" in item && item.type === "function_call_output"));
});

test("a failed repair stops after two calls and leaves existing state unchanged", async () => {
  const project = createProjectRecord("PK", "主播 PK");
  let calls = 0;
  const invalid = turnResponse({
    expectedRevision: 0,
    assistantResponse: "invalid",
    operations: [{ kind: "update_product_spec", summary: "invalid", operations: [{ op: "REPLACE", path: "solution.foo", value: "bad" }] }],
    readyEvaluation: readyEvaluation()
  });
  const ai: AIProvider = { async generate() { calls += 1; return invalid; } };

  await assert.rejects(() => runToolLoop(project, "失败测试", ai), /repair failed/);
  assert.equal(calls, 2);
  assert.equal(project.productSpec.version.revision, 0);
  assert.equal(project.productSpec.discovery.problem, undefined);
});

test("stage turn adapts common relay JSON variations without a repair call", async () => {
  const project = createProjectRecord("Adapter", "Improve PK adoption");
  let calls = 0;
  const ai: AIProvider = { async generate() {
    calls += 1;
    return {
      text: `\`\`\`json\n${JSON.stringify({
        expected_revision: "0",
        assistant_response: "已记录目标。",
        ops: [
          {
            type: "updateSpec",
            changes: [{ action: "set", field: "goals.primary", data: "提高真实 PK 使用" }]
          },
          {
            type: "recordDecision",
            decision: "先验证真实使用",
            reason: "避免刷量",
            affected_paths: "behaviorChange"
          }
        ],
        ready_evaluation: {
          criteria: { problem_clarity: { result: "partial", explanation: "仍需验证" } },
          summary: "继续 Discovery"
        }
      })}\n\`\`\``,
      calls: [],
      historyItems: []
    };
  } };

  const reply = await runToolLoop(project, "先记录目标", ai);

  assert.equal(calls, 1);
  assert.equal(project.productSpec.discovery.goals.primary, "提高真实 PK 使用");
  assert.equal(project.productSpec.decisions[0].affectedPaths[0], "discovery.behaviorChange");
  assert.match(reply, /系统提示/);
  assert.equal(project.workflow.stages.DISCOVERY.status, "IN_PROGRESS");
});

test("linked Discovery decision automatically restores a missing behaviorChange projection", async () => {
  const project = createProjectRecord("Projection recovery", "Improve PK adoption");
  project.productSpec.discovery.goals.primary = "让更多主播实际尝试 PK";
  project.productSpec.discovery.scenarios.push({
    id: "first-pk",
    actorId: "host",
    context: "PK 上线",
    goal: "完成首次真实 PK"
  });
  project.productSpec.decisions.push({
    id: "accepted-friction",
    stage: "DISCOVERY",
    decision: "先按新功能认知不足这一弱假设推进并在上线后验证",
    rationale: ["当前没有真实数据"],
    affectedPaths: ["discovery.behaviorChange"],
    status: "ACTIVE",
    source: { type: "SYSTEM" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  let sawProjection = false;
  const ai: AIProvider = { async generate() {
    sawProjection = project.productSpec.discovery.behaviorChange?.basis.type === "ACCEPTED_ASSUMPTION";
    return turnResponse({
      expectedRevision: project.productSpec.version.revision,
      assistantResponse: "已重新评估。",
      operations: [],
      readyEvaluation: readyEvaluation()
    });
  } };

  const reply = await runToolLoop(project, "重新评估", ai);

  assert.equal(sawProjection, true);
  assert.equal(project.productSpec.discovery.behaviorChange?.targetBehavior, "完成首次真实 PK");
  assert.equal(project.productSpec.discovery.behaviorChange?.basis.type, "ACCEPTED_ASSUMPTION");
  assert.match(reply, /系统提示/);
});

test("behaviorChange accepts common nested relay aliases", async () => {
  const project = createProjectRecord("Nested aliases", "Improve PK adoption");
  const ai: AIProvider = { async generate() {
    return turnResponse({
      expectedRevision: 0,
      assistantResponse: "已记录。",
      operations: [
        {
          kind: "record_decision",
          reference: "basis",
          decision: "先按认知不足推进",
          rationale: ["用户接受"],
          affectedPaths: ["discovery.behaviorChange"]
        },
        {
          kind: "update_product_spec",
          operations: [{
            op: "REPLACE",
            path: "discovery.behaviorChange",
            value: {
              target_behavior: "完成首次 PK",
              basis: {
                type: "accepted-assumption",
                assumption: "主播不了解新功能",
                evidence_status: "unverified",
                decision_id: "$decision:basis",
                validation_plan: "上线后观察真实 PK 发起"
              }
            }
          }]
        }
      ],
      readyEvaluation: readyEvaluation()
    });
  } };

  await runToolLoop(project, "按该假设推进", ai);

  const behaviorChange = project.productSpec.discovery.behaviorChange;
  assert.equal(behaviorChange?.targetBehavior, "完成首次 PK");
  assert.equal(behaviorChange?.basis.type, "ACCEPTED_ASSUMPTION");
  if (behaviorChange?.basis.type !== "ACCEPTED_ASSUMPTION") assert.fail("expected accepted assumption");
  assert.equal(behaviorChange.basis.evidenceStatus, "UNVALIDATED");
  assert.equal(behaviorChange.basis.decisionId, project.productSpec.decisions[0].id);
});

test("one incomplete non-security operation no longer rolls back safe updates", async () => {
  const project = createProjectRecord("Partial", "Improve PK adoption");
  let calls = 0;
  const ai: AIProvider = { async generate() {
    calls += 1;
    return turnResponse({
      expectedRevision: 0,
      assistantResponse: "已保存能够确认的内容。",
      operations: [
        {
          kind: "update_product_spec",
          operations: [{ op: "REPLACE", path: "discovery.goals.primary", value: "提高真实 PK 使用" }]
        },
        { kind: "record_decision", decision: "缺少理由和影响路径" }
      ],
      readyEvaluation: readyEvaluation()
    });
  } };

  const reply = await runToolLoop(project, "保存已确认内容", ai);

  assert.equal(calls, 1);
  assert.equal(project.productSpec.discovery.goals.primary, "提高真实 PK 使用");
  assert.equal(project.productSpec.decisions.length, 0);
  assert.match(reply, /系统提示/);
  assert.ok(project.workflow.stages.DISCOVERY.readyEvaluation);
  assert.equal(project.workflow.stages.DISCOVERY.status, "IN_PROGRESS");
});

test("completed Solution criteria close stale blockers routed back from generation", async () => {
  const project = createProjectRecord("Generation blocker", "Define campaign rules");
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.DISCOVERY.confirmedVersion = 1;
  project.workflow.stages.SOLUTION.status = "IN_PROGRESS";
  project.workflow.activeStage = "SOLUTION";
  project.productSpec.openQuestions.push({
    id: "generated-blocker",
    createdInStage: "SOLUTION",
    ownerStage: "SOLUTION",
    question: "Confirm the reward rule",
    impact: "Required for PRD",
    blocking: true,
    resolutionMethod: "PRODUCT_DECISION",
    status: "OPEN",
    source: { type: "GENERATION", artifact: "PRD" }
  });
  const completeCriteria = stageRegistry.SOLUTION.exitCriteriaIds.map(criterionId => ({
    criterionId,
    status: "SUFFICIENT",
    reason: "complete"
  }));
  const ai: AIProvider = { async generate() {
    return {
      text: "",
      historyItems: [],
      calls: [{ callId: "solution", name: "complete_solution_turn", arguments: JSON.stringify({
        expectedRevision: 0,
        assistantResponse: "规则已补充。",
        operations: [],
        readyEvaluation: { criteria: completeCriteria, blockingUnknownIds: [], summary: "本轮已解决全部 PRD 回流阻塞问题。" }
      }) }]
    };
  } };

  await runToolLoop(project, "补充规则", ai);

  assert.equal(project.productSpec.openQuestions[0].status, "RESOLVED");
  assert.equal(project.productSpec.openQuestions[0].blocking, true);
});
