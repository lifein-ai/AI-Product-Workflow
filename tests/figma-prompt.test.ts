import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider, ModelResponse } from "../src/ai/provider.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { FigmaPromptService } from "../src/figma/figma-prompt-service.js";
import { FigmaPromptCatalog } from "../src/figma/prompt-catalog.js";
import { PrdService } from "../src/prd/prd-service.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { buildConfirmedProductState } from "../src/workflow/confirmed-product-state.js";

function functionResponse(name: string, args: unknown): ModelResponse {
  return { text: "", calls: [{ callId: name, name, arguments: JSON.stringify(args) }], historyItems: [] };
}

function figmaPlan(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "figma-meta-plan.v1",
    analysis: {
      taskType: "多人直播移动端原型",
      pageTypes: ["LIVE Room", "Bottom Sheet", "Dialog"],
      coreCapabilities: ["Seat", "Join", "Host Management"]
    },
    selection: {
      baseId: "figma.base.v2",
      domainCapabilityIds: ["figma.capability.multi-guest-live"],
      supportCapabilityIds: []
    },
    capabilityGaps: [],
    canAssemble: true,
    blockingIssues: [],
    ...overrides
  };
}

function confirmedProjectWithPrd() {
  const project = createProjectRecord("Multi-Guest LIVE", "增加多人直播能力");
  project.productSpec.discovery.currentProduct.capabilities.push("Normal LIVE");
  project.productSpec.solution.summary = "增加多人直播模式";
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.DISCOVERY.contentVersion = 2;
  project.workflow.stages.DISCOVERY.confirmedVersion = 2;
  project.workflow.stages.SOLUTION.status = "CONFIRMED";
  project.workflow.stages.SOLUTION.contentVersion = 4;
  project.workflow.stages.SOLUTION.confirmedVersion = 4;
  project.workflow.activeStage = null;
  project.confirmedProductState = buildConfirmedProductState(project);
  project.artifacts.prd = {
    contentRevision: 3,
    lifecycleStatus: "CURRENT",
    reviewStatus: "CONFIRMED",
    sourceVersions: { discovery: 2, solution: 4, productSpecRevision: 0 },
    selectedPromptIds: ["prd.base", "prd.capability.live"],
    promptHashes: {},
    generatedContent: "## Multi-Guest LIVE\n\n- Host 可管理 Guest Seat。",
    currentContent: "## Multi-Guest LIVE\n\n- Host 可管理 Guest Seat。",
    openQuestions: [],
    clarifications: [],
    generationNotes: [],
    blockingIssues: [],
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString()
  };
  project.artifacts.interaction = {
    contentRevision: 2,
    lifecycleStatus: "CURRENT",
    reviewStatus: "CONFIRMED",
    sourceVersions: {
      discovery: 2, solution: 4, productSpecRevision: 0,
      confirmedProductStateVersion: 1, confirmedProductStateHash: project.confirmedProductState.contentHash, prd: 3
    },
    promptHash: "interaction-prompt",
    generatedContent: "## Interaction Specification\n\n- Host follows the confirmed main flow.",
    currentContent: "## Interaction Specification\n\n- Host follows the confirmed main flow.",
    openQuestions: [], clarifications: [], generationNotes: [], blockingIssues: [],
    generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confirmedAt: new Date().toISOString()
  };
  return project;
}

test("Figma Prompt uses one Meta call then deterministic assembly", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(confirmedProjectWithPrd());
  const requests: Parameters<AIProvider["generate"]>[0][] = [];
  const ai: AIProvider = {
    async generate(request) {
      requests.push(request);
      return functionResponse("complete_figma_meta_analysis", figmaPlan());
    }
  };

  const result = await new FigmaPromptService(repo, ai).generate(created.id);

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].toolNames, ["complete_figma_meta_analysis"]);
  assert.match(requests[0].instructions, /# Prompt Selection Context/);
  assert.doesNotMatch(requests[0].instructions, /Host 可管理 Guest Seat。/);
  assert.equal(result.artifact.lifecycleStatus, "CURRENT");
  assert.equal(result.artifact.reviewStatus, "DRAFT");
  assert.equal(result.artifact.sourceVersions?.discovery, 2);
  assert.equal(result.artifact.sourceVersions?.solution, 4);
  assert.equal(result.artifact.sourceVersions?.prd, 3);
  assert.equal(result.artifact.sourceVersions?.confirmedProductStateVersion, 1);
  assert.ok(result.artifact.sourceVersions?.confirmedProductStateHash);
  assert.deepEqual(result.artifact.selectedPromptIds, ["figma.base.v2", "figma.capability.multi-guest-live"]);
  assert.match(result.artifact.currentContent!, /# Figma Base Prompt/);
  assert.match(result.artifact.currentContent!, /# Multi\\-Guest Live Capability/);
  assert.match(result.artifact.currentContent!, /# Reusable Asset Registry/);
  assert.match(result.artifact.currentContent!, /Guest Seat/);
  assert.match(result.artifact.currentContent!, /# Confirmed PRD Requirement Details/);
  assert.match(result.artifact.currentContent!, /# Confirmed Interaction Specification/);
  assert.match(result.artifact.currentContent!, /Host follows the confirmed main flow/);
});

test("Figma Prompt stops after Meta when a capability is missing", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(confirmedProjectWithPrd());
  let calls = 0;
  const ai: AIProvider = {
    async generate() {
      calls += 1;
      return functionResponse("complete_figma_meta_analysis", figmaPlan({
        capabilityGaps: [{ capabilityName: "Social Design", reason: "No reusable capability exists" }],
        canAssemble: false,
        blockingIssues: ["Social Design Capability is missing"]
      }));
    }
  };
  const result = await new FigmaPromptService(repo, ai).generate(created.id);
  assert.equal(calls, 1);
  assert.equal(result.artifact.reviewStatus, "BLOCKED");
  assert.match(result.artifact.blockingIssues.join("\n"), /Social Design/);
});

test("Figma Prompt supports review and becomes stale when confirmed PRD changes", async () => {
  const repo = new InMemoryProjectRepository();
  const created = await repo.create(confirmedProjectWithPrd());
  const ai: AIProvider = { async generate() { return functionResponse("complete_figma_meta_analysis", figmaPlan()); } };
  const figma = new FigmaPromptService(repo, ai);
  await figma.generate(created.id);
  const edited = await figma.update(created.id, "# Codex Figma Prototype Task\n\n人工补充执行信息");
  assert.match(edited.artifact.currentContent!, /人工补充/);
  const confirmed = await figma.confirm(created.id);
  assert.equal(confirmed.artifact.reviewStatus, "CONFIRMED");

  const prd = new PrdService(repo, ai);
  await prd.update(created.id, "## 更新后的 PRD\n\n- 新规则。");
  const stored = (await repo.getById(created.id))!;
  assert.equal(stored.artifacts.figmaPrompt.lifecycleStatus, "STALE");
  await assert.rejects(() => figma.update(created.id, "不可覆盖"), /no longer current/);
});

test("runtime Figma Prompt Registry selects only active executable assets", async () => {
  const catalog = new FigmaPromptCatalog();
  const entries = await catalog.metaRegistryView();
  assert.ok(entries.some(entry => entry.id === "figma.base.v2" && entry.status === "STABLE"));
  assert.ok(entries.some(entry => entry.id === "figma.base.v1" && entry.status === "DEPRECATED"));
  assert.ok(entries.some(entry => entry.id === "figma.capability.component-reuse" && entry.status === "DRAFT"));
  await catalog.validateSelection(figmaPlan().selection);
  await assert.rejects(() => catalog.validateSelection({
    baseId: "figma.base.v2",
    domainCapabilityIds: [],
    supportCapabilityIds: ["figma.capability.component-reuse"]
  }), /non-executable/);
});
