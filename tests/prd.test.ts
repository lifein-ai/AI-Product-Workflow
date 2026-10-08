import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider, ModelResponse } from "../src/ai/provider.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { PrdPromptCatalog } from "../src/prd/prompt-catalog.js";
import { PrdService } from "../src/prd/prd-service.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { markStageContentChanged } from "../src/workflow/state-machine.js";

function functionResponse(name: string, args: unknown, callId = name): ModelResponse {
  return {
    text: "",
    calls: [{ callId, name, arguments: JSON.stringify(args) }],
    historyItems: []
  };
}

function metaPlan(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "prd-meta-plan.v1",
    analysis: {
      requirementType: "直播能力扩展",
      domains: ["Live"],
      coreObjects: ["Live Room", "Host", "Guest"],
      roles: ["Host", "Audience", "Guest"],
      goal: "生成多人直播需求详情"
    },
    selection: {
      baseId: "prd.base",
      domainCapabilityIds: ["prd.capability.live"],
      generalCapabilityIds: [],
      supportCapabilityIds: [],
      projectPromptIds: []
    },
    capabilityGaps: [],
    canGenerate: true,
    blockingIssues: [],
    ...overrides
  };
}

function confirmedProject() {
  const project = createProjectRecord("Multi-Guest LIVE", "增加多人直播能力");
  project.productSpec.discovery.goals.primary = "支持多人视频互动";
  project.productSpec.solution.summary = "在 LIVE 中增加 Multi-Guest 模式";
  project.productSpec.solution.coreSolution = "复用现有 LIVE 并增加固定 Guest Seat";
  project.productSpec.solution.keyMechanisms.push({ id: "seat", name: "Guest Seat", description: "固定座位承载 Guest" });
  project.productSpec.solution.scope.inScope.push("Multi-Guest LIVE");
  project.productSpec.solution.scope.outOfScope.push("PK");
  project.productSpec.solution.keyRules.push({ id: "mode", rule: "单场直播内不可切换模式" });
  project.productSpec.solution.mainProductFlow.push({ id: "start", step: "Host 创建 Multi-Guest LIVE" });
  project.productSpec.solution.tradeOffs.push({ id: "capacity", topic: "人数", decision: "支持4/6人", rationale: "覆盖首期场景" });
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.DISCOVERY.contentVersion = 3;
  project.workflow.stages.DISCOVERY.confirmedVersion = 3;
  project.workflow.stages.SOLUTION.status = "CONFIRMED";
  project.workflow.stages.SOLUTION.contentVersion = 5;
  project.workflow.stages.SOLUTION.confirmedVersion = 5;
  project.workflow.activeStage = null;
  return project;
}

test("PRD generation uses exactly two model calls and saves a reproducible draft", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(confirmedProject());
  const requests: Parameters<AIProvider["generate"]>[0][] = [];
  const ai: AIProvider = {
    async generate(request) {
      requests.push(request);
      if (request.toolNames[0] === "complete_prd_meta_analysis") {
        return functionResponse("complete_prd_meta_analysis", metaPlan());
      }
      return functionResponse("complete_prd_generation", {
        result: "GENERATED",
        requirementDetailsMarkdown: "## Multi-Guest LIVE 创建\n\n- Host 可创建多人直播。\n\n原型示意：开播配置页",
        openQuestions: [],
        generationNotes: []
      });
    }
  };

  const result = await new PrdService(repo, ai).generate(created.id);

  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(request => request.toolNames), [
    ["complete_prd_meta_analysis"],
    ["complete_prd_generation"]
  ]);
  assert.match(requests[0].instructions, /# Prompt Selection Context/);
  assert.doesNotMatch(requests[0].instructions, /"confirmedProductState"/);
  assert.doesNotMatch(requests[0].instructions, /"evidenceAndAssumptions"/);
  assert.match(requests[1].instructions, /# PRD Base Prompt/);
  assert.match(requests[1].instructions, /# Live Requirement Capability/);
  assert.match(requests[1].instructions, /# Confirmed Product Solution/);
  assert.equal(result.artifact.lifecycleStatus, "CURRENT");
  assert.equal(result.artifact.reviewStatus, "DRAFT");
  assert.equal(result.artifact.sourceVersions?.discovery, 3);
  assert.equal(result.artifact.sourceVersions?.solution, 5);
  assert.equal(result.artifact.sourceVersions?.productSpecRevision, 0);
  assert.equal(result.artifact.sourceVersions?.confirmedProductStateVersion, 1);
  await assert.rejects(() => new PrdService(repo, ai).generate(created.id), /must be cleared/);
  assert.equal(requests.length, 2);
  assert.ok(result.artifact.sourceVersions?.confirmedProductStateHash);
  assert.deepEqual(result.artifact.selectedPromptIds, ["prd.base", "prd.capability.live"]);
  assert.ok(result.artifact.totalPromptHash);
  assert.equal(result.artifact.generatedContent, result.artifact.currentContent);
});

test("a blocked PRD saves human clarification and resumes with one generation call without rerunning Meta", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(confirmedProject());
  const requests: Parameters<AIProvider["generate"]>[0][] = [];
  const ai: AIProvider = {
    async generate(request) {
      requests.push(request);
      if (request.toolNames[0] === "complete_prd_meta_analysis") {
        return functionResponse("complete_prd_meta_analysis", metaPlan());
      }
      if (requests.length === 2) {
        return functionResponse("complete_prd_generation", {
          result: "NEEDS_INPUT",
          openQuestions: [{ question: "Which timezone applies?", impact: "Defines activation boundaries", sourcePath: "solution.keyRules", scope: "ARTIFACT_DETAIL" }],
          generationNotes: []
        });
      }
      return functionResponse("complete_prd_generation", {
        result: "GENERATED",
        requirementDetailsMarkdown: "## 时间规则\n\n- 使用 Asia/Shanghai，结束时刻不包含在有效区间。",
        openQuestions: [],
        generationNotes: []
      });
    }
  };
  const service = new PrdService(repo, ai);

  const blocked = await service.generate(created.id);
  assert.equal(blocked.artifact.reviewStatus, "BLOCKED");
  assert.equal(requests.length, 2);

  const resumed = await service.clarifyAndGenerate(created.id, "Use Asia/Shanghai; the end instant is exclusive.");
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(request => request.toolNames[0]), [
    "complete_prd_meta_analysis",
    "complete_prd_generation",
    "complete_prd_generation"
  ]);
  assert.match(requests[2].instructions, /Human Clarifications/);
  assert.match(requests[2].instructions, /Asia\/Shanghai/);
  assert.equal(resumed.artifact.lifecycleStatus, "CURRENT");
  assert.equal(resumed.artifact.reviewStatus, "DRAFT");
  assert.equal(resumed.artifact.clarifications.length, 1);
  assert.equal(resumed.artifact.clarifications[0].questions[0].question, "Which timezone applies?");
  assert.match(resumed.artifact.currentContent!, /Asia\/Shanghai/);
});

test("a Draft or missing Capability stops after the Meta call", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(confirmedProject());
  let calls = 0;
  const ai: AIProvider = {
    async generate() {
      calls += 1;
      return functionResponse("complete_prd_meta_analysis", metaPlan({
        capabilityGaps: [{
          capabilityName: "Social Requirement",
          reason: "Registry only contains a Draft capability",
          existingPromptId: "prd.capability.social"
        }],
        canGenerate: false,
        blockingIssues: ["Social Requirement Capability is not executable"]
      }));
    }
  };

  const result = await new PrdService(repo, ai).generate(created.id);

  assert.equal(calls, 1);
  assert.equal(result.artifact.lifecycleStatus, "NOT_GENERATED");
  assert.equal(result.artifact.reviewStatus, "BLOCKED");
  assert.match(result.artifact.blockingIssues.join("\n"), /Social Requirement/);
});

test("a Meta issue that explicitly says it does not block PRD generation is treated as non-blocking", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(confirmedProject());
  let calls = 0;
  const ai: AIProvider = {
    async generate(request) {
      calls += 1;
      return request.toolNames[0] === "complete_prd_meta_analysis"
        ? functionResponse("complete_prd_meta_analysis", metaPlan({
            canGenerate: false,
            blockingIssues: ["具体参数后续确认；这些不阻止基于已确认产品状态生成PRD。"]
          }))
        : functionResponse("complete_prd_generation", {
            result: "GENERATED",
            requirementDetailsMarkdown: "## 可继续生成\n\n- 后置参数保留为待确认项。",
            openQuestions: [],
            generationNotes: []
          });
    }
  };

  const result = await new PrdService(repo, ai).generate(created.id);

  assert.equal(calls, 2);
  assert.equal(result.artifact.lifecycleStatus, "CURRENT");
  assert.equal(result.artifact.reviewStatus, "DRAFT");
});

test("a missing product rule reopens Solution instead of being answered inside the PRD artifact", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(confirmedProject());
  const ai: AIProvider = {
    async generate(request) {
      return request.toolNames[0] === "complete_prd_meta_analysis"
        ? functionResponse("complete_prd_meta_analysis", metaPlan())
        : functionResponse("complete_prd_generation", {
            result: "NEEDS_INPUT",
            openQuestions: [{
              question: "Which timezone defines activation?",
              impact: "Changes the business time boundary",
              sourcePath: "solution.keyRules",
              scope: "PRODUCT_DECISION"
            }],
            generationNotes: []
          });
    }
  };

  const result = await new PrdService(repo, ai).generate(created.id);
  assert.equal(result.artifact.reviewStatus, "BLOCKED");
  assert.equal(result.project.workflow.activeStage, "SOLUTION");
  assert.equal(result.project.workflow.stages.SOLUTION.status, "IN_PROGRESS");
  assert.equal(result.project.confirmedProductState?.lifecycleStatus, "STALE");
  assert.ok(result.project.productSpec.openQuestions.some(question =>
    question.ownerStage === "SOLUTION" && question.blocking && question.source?.artifact === "PRD"
  ));
  await assert.rejects(
    () => new PrdService(repo, ai).clarifyAndGenerate(created.id, "Use UTC+8"),
    /no longer current|not current/
  );
});

test("a generation question without an explicit scope stays in the current artifact", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(confirmedProject());
  const ai: AIProvider = {
    async generate(request) {
      return request.toolNames[0] === "complete_prd_meta_analysis"
        ? functionResponse("complete_prd_meta_analysis", metaPlan())
        : functionResponse("complete_prd_generation", {
            result: "NEEDS_INPUT",
            openQuestions: [{
              question: "Should the empty seat helper use a short or long label?",
              impact: "Changes interface copy only",
              sourcePath: "solution.keyRules"
            }],
            generationNotes: []
          });
    }
  };

  const result = await new PrdService(repo, ai).generate(created.id);
  assert.equal(result.project.workflow.activeStage, null);
  assert.equal(result.project.workflow.stages.SOLUTION.status, "CONFIRMED");
  assert.equal(result.artifact.openQuestions[0].scope, "ARTIFACT_DETAIL");
  assert.equal(result.project.productSpec.openQuestions.some(question => question.source?.type === "GENERATION"), false);
});

test("human edits are confirmed separately and upstream changes make the PRD stale", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(confirmedProject());
  const ai: AIProvider = {
    async generate(request) {
      return request.toolNames[0] === "complete_prd_meta_analysis"
        ? functionResponse("complete_prd_meta_analysis", metaPlan())
        : functionResponse("complete_prd_generation", {
            result: "GENERATED",
            requirementDetailsMarkdown: "## 初始需求\n\n- 初始内容。\n\n原型示意：直播页",
            openQuestions: [],
            generationNotes: []
          });
    }
  };
  const service = new PrdService(repo, ai);
  await service.generate(created.id);
  const edited = await service.update(created.id, "## 人工修订\n\n- 修订内容。\n\n原型示意：直播页");
  assert.equal(edited.artifact.generatedContent, "## 初始需求\n\n- 初始内容。\n\n原型示意：直播页");
  assert.match(edited.artifact.currentContent!, /人工修订/);

  const confirmed = await service.confirm(created.id);
  assert.equal(confirmed.artifact.reviewStatus, "CONFIRMED");

  const changed = (await repo.getById(created.id))!;
  markStageContentChanged(changed, "SOLUTION");
  await repo.save(changed);
  const stored = (await repo.getById(created.id))!;
  assert.equal(stored.artifacts.prd.lifecycleStatus, "STALE");
  await assert.rejects(() => service.update(created.id, "## 不允许覆盖旧来源"), /no longer current/);
});

test("runtime PRD Prompt Registry is internally consistent", async () => {
  const catalog = new PrdPromptCatalog();
  const entries = await catalog.metaRegistryView();
  assert.ok(entries.some(entry => entry.id === "prd.capability.prototype-to-requirement"));
  assert.ok(entries.some(entry => entry.id === "prd.capability.social" && entry.status === "DRAFT"));
  await catalog.validateSelection(metaPlan().selection);
});
