import assert from "node:assert/strict";
import test from "node:test";
import { createProjectRecord } from "../src/domain/factories.js";
import { executeTool } from "../src/tools/executor.js";
import { confirmStage } from "../src/workflow/state-machine.js";
import { stageRegistry } from "../src/workflow/stage-registry.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";

function completeDiscovery() {
  const project = createProjectRecord("PK", "主播 PK");
  executeTool(project, "update_product_spec", {
    expectedRevision: 0,
    summary: "Discovery facts",
    operations: [
      { op: "REPLACE", path: "discovery.problem", value: { statement: "主播互动不足" } },
      { op: "ADD", path: "discovery.users.primary", value: { id: "host", name: "主播" } },
      { op: "ADD", path: "discovery.scenarios", value: { id: "live", actorId: "host", context: "直播中", goal: "与其他主播互动" } },
      { op: "REPLACE", path: "discovery.goals.primary", value: "提高主播互动" },
      { op: "REPLACE", path: "discovery.direction", value: { summary: "提供主播间实时互动", rationale: [] } },
      { op: "ADD", path: "discovery.scope.mustSolve", value: "主播互动" }
    ]
  });
  return project;
}

function evaluate(project: ReturnType<typeof createProjectRecord>) {
  return executeTool(project, "evaluate_stage", {
    expectedRevision: project.productSpec.version.revision,
    criteria: stageRegistry.DISCOVERY.exitCriteriaIds.map(criterionId => ({
      criterionId, status: ["current_product_clarity", "constraint_clarity", "evidence_sufficiency"].includes(criterionId)
        ? "NOT_APPLICABLE" : "SUFFICIENT", reason: "Verified for test"
    })),
    blockingUnknownIds: [], summary: "Enough for confirmation"
  });
}

test("Discovery rejects Solution, Interaction, workflow, and unsafe paths atomically", () => {
  for (const path of ["solution.foo", "interaction.foo", "workflow.activeStage", "discovery.__proto__.polluted"]) {
    const project = createProjectRecord("PK", "主播 PK");
    const before = structuredClone(project);
    assert.throws(() => executeTool(project, "update_product_spec", {
      expectedRevision: 0, summary: "invalid", operations: [
        { op: "REPLACE", path: "discovery.problem", value: { statement: "valid" } },
        { op: "REPLACE", path, value: "invalid" }
      ]
    }));
    assert.deepEqual(project, before);
  }
});

test("Schema failure rolls back every Product Spec operation", () => {
  const project = createProjectRecord("PK", "主播 PK");
  const before = structuredClone(project);
  assert.throws(() => executeTool(project, "update_product_spec", {
    expectedRevision: 0, summary: "invalid shape", operations: [
      { op: "REPLACE", path: "discovery.problem", value: { statement: "valid" } },
      { op: "REPLACE", path: "discovery.users", value: "invalid" }
    ]
  }));
  assert.deepEqual(project, before);
});

test("Stale tool revision cannot overwrite newer Product Spec", () => {
  const project = completeDiscovery();
  assert.throws(() => executeTool(project, "update_product_spec", {
    expectedRevision: 0, summary: "stale", operations: [
      { op: "REPLACE", path: "discovery.goals.primary", value: "old goal" }
    ]
  }), /Stale/);
  assert.equal(project.productSpec.discovery.goals.primary, "提高主播互动");
});

test("AI evaluation only marks ready and only ready can be confirmed", () => {
  const project = completeDiscovery();
  assert.throws(() => confirmStage(project, "DISCOVERY"));
  const result = evaluate(project);
  assert.equal((result.data as { result: string }).result, "READY");
  assert.equal(project.workflow.stages.DISCOVERY.status, "READY_FOR_CONFIRMATION");
  assert.equal(project.workflow.stages.SOLUTION.status, "NOT_STARTED");
  confirmStage(project, "DISCOVERY");
  assert.equal(project.workflow.stages.DISCOVERY.status, "CONFIRMED");
});

test("Blocking open question prevents Ready and its later creation invalidates Ready", () => {
  const project = completeDiscovery();
  const created = executeTool(project, "manage_open_question", {
    expectedRevision: 1, action: "CREATE", question: "谁参与？", impact: "用户定位", blocking: true,
    resolutionMethod: "PRODUCT_DECISION"
  });
  assert.equal(project.workflow.stages.DISCOVERY.contentVersion, 2);
  assert.equal((evaluate(project).data as { result: string }).result, "NOT_READY");
  const id = (created.data as { id: string }).id;
  executeTool(project, "manage_open_question", {
    expectedRevision: 2, action: "RESOLVE", questionId: id, resolution: "主播"
  });
  evaluate(project);
  assert.equal(project.workflow.stages.DISCOVERY.status, "READY_FOR_CONFIRMATION");
  executeTool(project, "update_product_spec", {
    expectedRevision: 3, summary: "scope clarified", operations: [
      { op: "ADD", path: "discovery.scope.mustSolve", value: "连麦" }
    ]
  });
  assert.equal(project.workflow.stages.DISCOVERY.status, "IN_PROGRESS");
  assert.throws(() => confirmStage(project, "DISCOVERY"));
});

test("Superseding a decision links old and new records and invalidates Ready", () => {
  const project = completeDiscovery();
  const old = executeTool(project, "record_decision", {
    expectedRevision: 1, decision: "只支持双人", rationale: ["首版范围"], affectedPaths: ["discovery.scope.mustSolve"]
  }).data as { id: string };
  evaluate(project);
  const newer = executeTool(project, "record_decision", {
    expectedRevision: 2, decision: "支持多人", rationale: ["用户验证"], affectedPaths: ["discovery.scope.mustSolve"],
    supersedesDecisionId: old.id
  }).data as { id: string };
  assert.equal(project.productSpec.decisions[0].status, "SUPERSEDED");
  assert.equal(project.productSpec.decisions[0].supersededBy, newer.id);
  assert.equal(project.productSpec.decisions[1].status, "ACTIVE");
  assert.equal(project.workflow.stages.DISCOVERY.status, "IN_PROGRESS");
});

test("Retrying an identical replacement decision stays idempotent", () => {
  const project = completeDiscovery();
  const old = executeTool(project, "record_decision", {
    expectedRevision: 1, decision: "依赖邀请", rationale: ["现有能力"], affectedPaths: ["discovery.direction"]
  }).data as { id: string };
  const replacement = executeTool(project, "record_decision", {
    expectedRevision: 2, decision: "前置随机匹配", rationale: ["供给不足"], affectedPaths: ["discovery.direction"]
  }).data as { id: string };
  executeTool(project, "record_decision", {
    expectedRevision: 3, decision: "前置随机匹配", rationale: ["供给不足"], affectedPaths: ["discovery.direction"],
    supersedesDecisionId: old.id
  });
  assert.equal(project.productSpec.decisions.length, 2);
  assert.equal(project.productSpec.decisions[0].status, "SUPERSEDED");
  assert.equal(project.productSpec.decisions[0].supersededBy, replacement.id);
  assert.equal(project.productSpec.decisions[1].supersedesDecisionId, old.id);
});

test("Repository rejects concurrent saves including message-only changes", async () => {
  const repo = new InMemoryProjectRepository();
  const original = await repo.create(createProjectRecord("PK", "主播 PK"));
  const first = (await repo.getById(original.id))!;
  const stale = (await repo.getById(original.id))!;
  first.messages.push({ id: "1", role: "user", content: "hello", createdAt: new Date().toISOString() });
  await repo.save(first);
  await assert.rejects(repo.save(stale), /changed concurrently/);
});

test("Validation request remains in Product Spec with its expected output", () => {
  const project = createProjectRecord("PK", "主播 PK");
  executeTool(project, "request_validation", {
    expectedRevision: 0, type: "TECHNICAL", question: "现有直播服务支持双流吗？",
    reason: "影响技术可行性", blocking: true, expectedOutput: "架构结论"
  });
  assert.equal(project.productSpec.openQuestions[0].validation?.type, "TECHNICAL");
  assert.equal(project.productSpec.openQuestions[0].validation?.expectedOutput, "架构结论");
  assert.equal(project.workflow.stages.DISCOVERY.contentVersion, 1);
});

test("Discovery input adapter normalizes lossless model shapes and stable constraint aliases", () => {
  const project = createProjectRecord("Activity", "运营配置活动");
  executeTool(project, "update_product_spec", {
    expectedRevision: 0,
    summary: "Normalize provider output",
    operations: [
      { op: "REPLACE", path: "discovery.behaviorChange", value: {
        targetBehavior: "运营独立发布活动",
        basis: { type: "EVIDENCED_FRICTION", friction: "人工配置错误", evidence: "12 个活动中 5 个返工" }
      } },
      { op: "REPLACE", path: "discovery.constraints", value: [
        { id: "platform", type: "platform", description: "内部 Web 后台" },
        { id: "permission", type: "authorization", description: "沿用 RBAC" },
        { id: "delivery", type: "delivery", description: "两周交付" }
      ] }
    ]
  });
  assert.deepEqual(project.productSpec.discovery.behaviorChange?.basis.type === "EVIDENCED_FRICTION"
    ? project.productSpec.discovery.behaviorChange.basis.evidence
    : [], ["12 个活动中 5 个返工"]);
  assert.deepEqual(project.productSpec.discovery.constraints.map(item => item.type), ["TECHNICAL", "COMPLIANCE", "RESOURCE"]);
});

test("one Product Spec update accepts the complete 20-operation turn budget", () => {
  const project = createProjectRecord("Activity", "运营配置活动");
  const operations = Array.from({ length: 20 }, (_, index) => ({
    op: "REPLACE" as const,
    path: "discovery.background",
    value: { context: `Fact ${index}` }
  }));
  assert.doesNotThrow(() => executeTool(project, "update_product_spec", {
    expectedRevision: 0,
    summary: "Complete structured update",
    operations
  }));
  assert.equal(project.productSpec.discovery.background?.context, "Fact 19");
});

test("Product Spec paths accept numeric bracket notation without widening stage ownership", () => {
  const project = createProjectRecord("Activity", "运营配置活动");
  project.productSpec.discovery.scope.mustSolve.push("旧范围");
  executeTool(project, "update_product_spec", {
    expectedRevision: 0,
    summary: "Update one array item",
    operations: [{ op: "REPLACE", path: "discovery.scope.mustSolve[0]", value: "新范围" }]
  });
  assert.deepEqual(project.productSpec.discovery.scope.mustSolve, ["新范围"]);
  assert.throws(() => executeTool(project, "update_product_spec", {
    expectedRevision: 1,
    summary: "Cross-stage write",
    operations: [{ op: "REPLACE", path: "solution.scope.inScope[0]", value: "越权" }]
  }), /cannot write path/);
});

test("Decision provenance is server-authored and deferred decisions do not become active", () => {
  const project = createProjectRecord("Decision source", "Record a choice");
  const result = executeTool(project, "record_decision", {
    expectedRevision: 0,
    decision: "Delay animation choice",
    rationale: ["It does not block V0"],
    affectedPaths: ["discovery.scope.canDefer"],
    status: "DEFERRED"
  }, 0, { type: "USER_MESSAGE", messageId: "message-1", requestId: "request-1" });
  const recorded = result.data as { status: string; source: { type: string; messageId?: string } };
  assert.equal(recorded.status, "DEFERRED");
  assert.deepEqual(recorded.source, { type: "USER_MESSAGE", messageId: "message-1", requestId: "request-1" });
});
