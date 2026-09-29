import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider } from "../src/ai/provider.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";
import { executeTool } from "../src/tools/executor.js";
import { confirmStage, startStage } from "../src/workflow/state-machine.js";
import { stageRegistry } from "../src/workflow/stage-registry.js";

function confirmedDiscovery() {
  const project = createProjectRecord("Creator PK", "提高主播 PK 使用率");
  project.productSpec.discovery.problem = { statement: "主播 PK 使用率低" };
  project.productSpec.discovery.goals.primary = "提高主播 PK 使用率";
  project.productSpec.discovery.users.primary.push({ id: "creator", name: "主播" });
  project.productSpec.discovery.scenarios.push({ id: "live", actorId: "creator", context: "直播中", goal: "参与 PK" });
  project.productSpec.discovery.direction = { summary: "解决已确认的参与阻力", rationale: [] };
  project.productSpec.discovery.scope.mustSolve.push("提高 PK 参与");
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.DISCOVERY.confirmedVersion = project.workflow.stages.DISCOVERY.contentVersion;
  return project;
}

function solutionEvaluation(status: "SUFFICIENT" | "MISSING") {
  return {
    expectedRevision: 1,
    criteria: stageRegistry.SOLUTION.exitCriteriaIds.map(criterionId => ({ criterionId, status, reason: "test" })),
    blockingUnknownIds: [],
    summary: "Solution evaluation"
  };
}

function populateSolution(project: ReturnType<typeof confirmedDiscovery>) {
  return executeTool(project, "update_product_spec", {
    expectedRevision: 0,
    summary: "Complete Product Solution",
    operations: [
      { op: "REPLACE", path: "solution.summary", value: "通过可发现的组局和阶段激励提高 PK 参与" },
      { op: "REPLACE", path: "solution.coreSolution", value: "面向目标主播提供组局、任务和效果验证闭环" },
      { op: "ADD", path: "solution.keyMechanisms", value: { id: "matching", name: "组局", description: "展示当前可 PK 对手" } },
      { op: "ADD", path: "solution.scope.inScope", value: "主播组局和参与任务" },
      { op: "ADD", path: "solution.scope.outOfScope", value: "直播间视觉改版" },
      { op: "ADD", path: "solution.keyRules", value: { id: "eligibility", rule: "仅稳定开播主播参与" } },
      { op: "ADD", path: "solution.mainProductFlow", value: { id: "join", actor: "主播", step: "查看活动并选择对手", outcome: "发起 PK" } },
      { op: "ADD", path: "solution.tradeOffs", value: { id: "supply", topic: "匹配范围", decision: "优先同层级主播", rationale: "兼顾成功率和公平性" } }
    ]
  });
}

test("Solution cannot start before Discovery confirmation", () => {
  const project = createProjectRecord("PK", "主播 PK");
  assert.throws(() => startStage(project, "SOLUTION"), /Discovery must be confirmed/);
  assert.equal(project.workflow.stages.SOLUTION.status, "NOT_STARTED");
});

test("starting Solution uses confirmed Discovery and creates one Solution AI turn", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(confirmedDiscovery());
  const seen: Array<{ instructions: string; toolNames: string[] }> = [];
  const ai: AIProvider = { async generate(request) {
    seen.push({ instructions: request.instructions, toolNames: request.toolNames });
    const args = {
      expectedRevision: 0,
      assistantResponse: "建议先围绕已确认阻力形成组局和激励闭环。需要确认奖励公平性取舍。",
      operations: [{
        kind: "update_product_spec", summary: "Initial solution", operations: [
          { op: "REPLACE", path: "solution.summary", value: "围绕组局和激励提高 PK 参与" },
          { op: "REPLACE", path: "solution.coreSolution", value: "提供组局入口和阶段任务" }
        ]
      }],
      readyEvaluation: {
        criteria: stageRegistry.SOLUTION.exitCriteriaIds.map(criterionId => ({ criterionId, status: "MISSING", reason: "需要继续收敛" })),
        blockingUnknownIds: [], summary: "Not ready"
      }
    };
    return {
      text: "", calls: [{ callId: "solution", name: "complete_solution_turn", arguments: JSON.stringify(args) }],
      historyItems: [{ type: "function_call", call_id: "solution" }]
    };
  } };

  const result = await new RuntimeService(repo, ai).startSolution(created.id);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].toolNames, ["complete_solution_turn"]);
  assert.match(seen[0].instructions, /主播 PK 使用率低/);
  assert.equal(result.project.workflow.activeStage, "SOLUTION");
  assert.equal(result.project.workflow.stages.SOLUTION.status, "IN_PROGRESS");
  assert.equal(result.project.productSpec.solution.summary, "围绕组局和激励提高 PK 参与");
  assert.equal(result.project.messages.length, 1);
  assert.equal(result.project.messages[0].stage, "SOLUTION");
  assert.equal(result.project.messages[0].role, "assistant");
});

test("Solution can only mutate its owned root", () => {
  const project = confirmedDiscovery();
  startStage(project, "SOLUTION");
  const before = structuredClone(project.productSpec.discovery);
  assert.throws(() => executeTool(project, "update_product_spec", {
    expectedRevision: 0, summary: "invalid", operations: [{ op: "REPLACE", path: "discovery.problem", value: { statement: "changed" } }]
  }), /cannot write path/);
  assert.deepEqual(project.productSpec.discovery, before);
});

test("an AI-authored initial solution cannot be Ready before a user trade-off decision", () => {
  const project = confirmedDiscovery();
  startStage(project, "SOLUTION");
  populateSolution(project);
  const result = executeTool(project, "evaluate_stage", solutionEvaluation("SUFFICIENT"));
  assert.equal((result.data as { result: string }).result, "NOT_READY");
  assert.match((result.data as { validationIssues: string[] }).validationIssues.join("\n"), /active Solution decision/);
});

test("Solution Ready requires complete structure and no blocking Solution question", () => {
  const project = confirmedDiscovery();
  startStage(project, "SOLUTION");
  populateSolution(project);
  executeTool(project, "record_decision", {
    expectedRevision: 1, decision: "采用同层级优先的匹配范围", rationale: ["用户确认公平性优先"], affectedPaths: ["solution.tradeOffs"]
  });
  const question = executeTool(project, "manage_open_question", {
    expectedRevision: 2, action: "CREATE", question: "奖励成本上限是什么？", impact: "阻塞激励规则落地",
    blocking: true, resolutionMethod: "PRODUCT_DECISION"
  }).data as { id: string };
  const blocked = executeTool(project, "evaluate_stage", { ...solutionEvaluation("SUFFICIENT"), expectedRevision: 3, blockingUnknownIds: [question.id] });
  assert.equal((blocked.data as { result: string }).result, "NOT_READY");
  executeTool(project, "manage_open_question", {
    expectedRevision: 3, action: "RESOLVE", questionId: question.id, resolution: "使用固定预算池"
  });
  const ready = executeTool(project, "evaluate_stage", { ...solutionEvaluation("SUFFICIENT"), expectedRevision: 4 });
  assert.equal((ready.data as { result: string }).result, "READY");
  assert.equal(project.workflow.stages.SOLUTION.status, "READY_FOR_CONFIRMATION");
  confirmStage(project, "SOLUTION");
  assert.equal(project.workflow.stages.SOLUTION.status, "CONFIRMED");
  assert.equal(project.workflow.activeStage, null);
  assert.equal(project.confirmedProductState?.lifecycleStatus, "CURRENT");
  assert.equal(project.confirmedProductState?.sourceVersions.solution, project.workflow.stages.SOLUTION.confirmedVersion);
  assert.equal(project.workflow.stages.INTERACTION.status, "NOT_STARTED");
});
