import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createProjectRecord } from "../src/domain/factories.js";
import type { BehaviorChangeDefinition, ProjectRecord } from "../src/domain/types.js";
import { executeTool } from "../src/tools/executor.js";
import { stageRegistry } from "../src/workflow/stage-registry.js";

function createStructurallyCompleteDiscovery(initialRequirement: string, goal: string, behaviorChange?: BehaviorChangeDefinition): ProjectRecord {
  const project = createProjectRecord("Ready benchmark", initialRequirement);
  executeTool(project, "update_product_spec", {
    expectedRevision: 0,
    summary: "Populate the Discovery facts that are not under test",
    operations: [
      { op: "REPLACE", path: "discovery.problem", value: { statement: "目标行为的当前表现低于预期" } },
      { op: "ADD", path: "discovery.users.primary", value: { id: "creator", name: "主播" } },
      { op: "ADD", path: "discovery.scenarios", value: { id: "core", actorId: "creator", context: "主播开播期间", goal: "完成目标行为" } },
      { op: "REPLACE", path: "discovery.goals.primary", value: goal },
      { op: "REPLACE", path: "discovery.direction", value: { summary: "围绕已确认的行为阻力确定初始方向", rationale: [] } },
      { op: "ADD", path: "discovery.scope.mustSolve", value: "推动目标行为并验证变化" },
      ...(behaviorChange ? [{ op: "REPLACE", path: "discovery.behaviorChange", value: behaviorChange }] : [])
    ]
  });
  return project;
}

function createBlockingFrictionQuestion(project: ProjectRecord, question: string) {
  return executeTool(project, "manage_open_question", {
    expectedRevision: project.productSpec.version.revision,
    action: "CREATE",
    question,
    impact: "答案会改变应优先解决的阻力和 Solution Direction",
    blocking: true,
    resolutionMethod: "PRODUCT_DECISION"
  }).data as { id: string };
}

function evaluate(project: ProjectRecord, behaviorBasisStatus: "SUFFICIENT" | "MISSING", blockingUnknownIds: string[] = []) {
  return executeTool(project, "evaluate_stage", {
    expectedRevision: project.productSpec.version.revision,
    criteria: stageRegistry.DISCOVERY.exitCriteriaIds.map(criterionId => ({
      criterionId,
      status: criterionId === "behavior_change_basis"
        ? behaviorBasisStatus
        : ["current_product_clarity", "constraint_clarity", "evidence_sufficiency"].includes(criterionId)
          ? "NOT_APPLICABLE"
          : "SUFFICIENT",
      reason: "Benchmark evaluation"
    })),
    blockingUnknownIds,
    summary: "Semantic Ready benchmark"
  });
}

test("benchmark: vague behavior-change requirement is not Ready", () => {
  const project = createStructurallyCompleteDiscovery("想让更多主播参与起来，但需求还很模糊", "提高主播参与率");
  const unknown = createBlockingFrictionQuestion(project, "主播当前不参与的关键原因是什么？");

  const result = evaluate(project, "MISSING", [unknown.id]);

  assert.equal((result.data as { result: string }).result, "NOT_READY");
  assert.equal(project.workflow.stages.DISCOVERY.status, "IN_PROGRESS");
});

test("benchmark: solution-first request is not evidence of the causal friction", () => {
  const project = createStructurallyCompleteDiscovery("做一个 PK 排行榜活动提高主播参与率", "提高 Creator 1v1 PK Participation");
  const unknown = createBlockingFrictionQuestion(project, "排行榜对应的核心参与阻力是否真实存在？");

  const result = evaluate(project, "MISSING", [unknown.id]);

  assert.equal((result.data as { result: string }).result, "NOT_READY");
  assert.match((result.data as { validationIssues: string[] }).validationIssues.join("\n"), /behaviorChange/);
});

test("benchmark: unknown Creator PK friction remains not Ready", () => {
  const project = createStructurallyCompleteDiscovery(
    "我们刚上线主播 1v1 PK，希望做活动促进使用，但上线 7 天还不知道主要阻力",
    "提高 Creator 1v1 PK Participation"
  );
  const unknown = createBlockingFrictionQuestion(project, "同时在线不足、找对手困难、功能认知低，哪一个是主要阻力？");

  const result = evaluate(project, "MISSING", [unknown.id]);

  assert.equal((result.data as { result: string }).result, "NOT_READY");
  assert.deepEqual((result.data as { blockingUnknownIds: string[] }).blockingUnknownIds, [unknown.id]);
});

test("benchmark: evidenced core friction is Ready while an ordinary unknown remains open", () => {
  const project = createStructurallyCompleteDiscovery(
    "访谈显示 8/10 主播找不到 PK 入口，希望提高参与率",
    "提高主播 PK 参与率",
    {
      targetBehavior: "主播发起或接受 1v1 PK",
      basis: {
        type: "EVIDENCED_FRICTION",
        friction: "主播难以发现 PK 入口",
        evidence: ["8/10 受访主播表示没有找到入口"]
      }
    }
  );
  executeTool(project, "manage_open_question", {
    expectedRevision: project.productSpec.version.revision,
    action: "CREATE",
    question: "奖励阈值应设为多少？",
    impact: "只影响后续方案参数，不改变初始方向",
    blocking: false,
    resolutionMethod: "DEFER"
  });

  const result = evaluate(project, "SUFFICIENT");

  assert.equal((result.data as { result: string }).result, "READY");
  assert.equal(project.workflow.stages.DISCOVERY.status, "READY_FOR_CONFIRMATION");
  assert.equal(project.productSpec.openQuestions[0].status, "OPEN");
});

test("benchmark: user-accepted assumption is Ready with decision and validation intent", () => {
  const project = createStructurallyCompleteDiscovery(
    "主要原因暂时未知；先假设主播不知道入口并做实验",
    "提高主播 PK 使用率"
  );
  const decision = executeTool(project, "record_decision", {
    expectedRevision: project.productSpec.version.revision,
    decision: "用户确认先按入口认知不足的假设推进小流量实验",
    rationale: ["当前证据不足，先用可验证的假设收敛方向"],
    affectedPaths: ["discovery.behaviorChange", "discovery.direction"]
  }).data as { id: string };
  executeTool(project, "update_product_spec", {
    expectedRevision: project.productSpec.version.revision,
    summary: "Record the explicitly accepted behavior assumption",
    operations: [{
      op: "REPLACE",
      path: "discovery.behaviorChange",
      value: {
        targetBehavior: "主播发起或接受 1v1 PK",
        basis: {
          type: "ACCEPTED_ASSUMPTION",
          assumption: "主播参与低主要因为不知道 PK 入口",
          evidenceStatus: "UNVALIDATED",
          decisionId: decision.id,
          validationIntent: "小流量曝光实验比较入口曝光前后的 PK 发起率"
        }
      }
    }]
  });
  executeTool(project, "request_validation", {
    expectedRevision: project.productSpec.version.revision,
    type: "DATA",
    question: "入口曝光是否提高 PK 发起率？",
    reason: "验证用户明确接受的行为原因假设",
    blocking: false,
    expectedOutput: "实验组与对照组的 PK 发起率差异"
  });

  const result = evaluate(project, "SUFFICIENT");

  assert.equal((result.data as { result: string }).result, "READY");
  assert.equal(project.workflow.stages.DISCOVERY.status, "READY_FOR_CONFIRMATION");
  assert.equal(project.productSpec.openQuestions[0].blocking, false);
});

test("accepted assumption cannot become Ready without an active linked decision", () => {
  const project = createStructurallyCompleteDiscovery(
    "先假设主播不知道入口并提高使用率",
    "提高主播 PK 使用率",
    {
      targetBehavior: "主播发起 PK",
      basis: {
        type: "ACCEPTED_ASSUMPTION",
        assumption: "主播不知道入口",
        evidenceStatus: "UNVALIDATED",
        decisionId: "missing-decision",
        validationIntent: "验证入口曝光是否提高发起率"
      }
    }
  );

  const result = evaluate(project, "SUFFICIENT");

  assert.equal((result.data as { result: string }).result, "NOT_READY");
  assert.match((result.data as { validationIssues: string[] }).validationIssues.join("\n"), /active Discovery decision/);
});

test("the recorded Creator PK E2E can no longer pass Ready with its friction unresolved", () => {
  const report = JSON.parse(readFileSync("reports/creator-pk-discovery-e2e.json", "utf8")) as {
    turns: Array<{ project: ProjectRecord }>;
  };
  const project = structuredClone(report.turns.at(-1)!.project);
  project.workflow.stages.DISCOVERY.status = "IN_PROGRESS";
  project.workflow.stages.DISCOVERY.readyEvaluation = undefined;

  const result = evaluate(project, "MISSING");

  assert.equal((result.data as { result: string }).result, "NOT_READY");
  assert.match((result.data as { validationIssues: string[] }).validationIssues.join("\n"), /behavior-change goals require discovery\.behaviorChange/);
});
