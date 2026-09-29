import "../src/config/load-env.js";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { createAIProvider } from "../src/ai/provider-factory.js";
import type { ProjectRecord } from "../src/domain/types.js";
import { FigmaPromptService } from "../src/figma/figma-prompt-service.js";
import { PrdService } from "../src/prd/prd-service.js";
import { InteractionService } from "../src/interaction/interaction-service.js";
import { FileProjectRepository } from "../src/repositories/file-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";
import { markStageContentChanged } from "../src/workflow/state-machine.js";

const initialRequirement = [
  "我们要改善内部运营配置营销活动的流程。主要用户是负责创建和发布活动的活动运营专员。",
  "当前流程是运营在表格和群聊中整理活动标题、起止时间、适用用户条件和规则文案，再请研发人工配置；系统已有用户分群、公告发布、定时任务和内部 RBAC，但没有结构化的活动配置与发布校验。",
  "过去 12 个活动中有 5 个因为字段遗漏或多版本信息产生返工，其中 2 个出现过起止时间配置错误；这是本轮已确认的核心摩擦证据。",
  "主要目标是让运营能够独立、准确地创建并发布活动配置，减少研发介入和配置返工；目标行为是运营完成结构化配置、校验并发布。",
  "本轮方向是复用现有用户分群、公告、定时任务和 RBAC，提供活动草稿、必填与时间校验、发布前预览和发布快照。",
  "V0 必须覆盖草稿创建编辑、适用用户条件、起止时间、规则文案、校验、预览和发布；暂不做多人审批、多语言、复杂奖励结算、活动效果分析和外部用户端改版。",
  "约束是内部 Web 后台、沿用现有运营权限、两周内完成 V0。上述数据和范围均作为本次验收的已确认事实。"
].join("\n");

const discoveryFollowups = [
  "我确认核心用户、现状、证据、目标行为、方向、范围和约束均以首条信息为准。配置错误与返工记录是已确认事实，不需要再等待额外研究；复杂奖励结算和效果分析明确不在 V0。请只保留真正阻塞 Product Solution 的未知并完成 Ready 评估。",
  "本轮没有其他阻塞未知。用户就是拥有现有活动运营权限的运营专员；成功标准是运营可独立发布且必填、时间范围校验通过。请将参数细节作为非阻塞项并完成 Discovery Ready 评估。"
];

const solutionDecisions = [
  [
    "我确认 V0 采用单一活动配置工作台，入口位于现有运营后台导航，复用已有列表、详情、表单、状态标签、日期时间、分群选择、Toast、确认弹窗和操作记录组件。页面覆盖活动列表、配置工作台、只读发布预览、已发布快照/版本详情和详情内操作记录。",
    "固定字段为标题（1-100 字）、起止时间、单个适用用户分群和规则文案（1-5000 字）；统一 Asia/Shanghai，开始时间不得早于当前时间且必须早于结束时间，分群必须存在、启用且当前运营角色有引用权限。保存草稿只保存；点击‘校验并预览’才校验，修改草稿会使旧校验和预览失效，确认发布前服务端再次强制校验。",
    "状态机采用 DRAFT、READY_TO_PUBLISH、PUBLISHING、PUBLISH_FAILED、PUBLISHED、ENDED、REVISION_DRAFT。公告或定时任务任一失败都按整体失败：不生成发布快照，保留草稿和失败原因，支持幂等重试，由活动服务处理部分成功补偿或对账。成功后生成不可变快照。",
    "发布动作只允许现有活动运营角色。活动模块向分群传 segmentId，向公告与定时任务传 activityId、revisionId、标题、规则文案、分群ID、开始和结束时间，只在发布或修订发布时创建或更新。已发布活动点击编辑时系统自动基于快照创建修订草稿；修订成功替换当前生效版本但永久保留旧快照；活动结束后不得再发布修订。",
    "范围包含草稿、校验、预览、发布、修订、发布快照、幂等失败处理和基础操作记录，不包含多人审批、多语言、奖励结算、效果分析和用户端改版。操作记录供活动运营专员和后台管理员查看，记录操作类型、操作人、时间、activityId、revisionId、结果和失败原因。Trade-off 是固定字段而非通用搭建器，以扩展性换两周内可交付和更低错误率。以上均为已确认 Product Decision，请完成 Ready 评估。"
  ].join("\n"),
  "补充并修改决定：标题、起止时间、适用用户分群和规则文案任一必填缺失，开始时间不早于结束时间，或分群不存在时，一律阻断发布，不允许忽略警告继续；发布动作仅允许现有活动运营角色。公告或定时任务任一失败或部分成功都按整体发布失败处理：保持草稿、不生成发布快照、展示失败原因，并允许幂等重试，后台负责对部分成功进行补偿或对账。与此同时，我修改之前“用户手动复制已发布版本为新草稿”的决定：用户点击编辑已发布活动时，由系统自动基于不可变快照创建修订草稿并进入编辑，不再要求用户手动执行复制；旧发布快照仍不得覆盖。请将新的修订草稿决定明确记录为覆盖旧决定（SUPERSEDED），解决对应待确认项并完成 Product Solution Ready 评估。"
];

const prdClarification = "统一使用 UTC+8（Asia/Shanghai）。开始时间到点生效；结束时间到点立即停止，结束时刻不包含在有效区间。";
const interactionClarification = [
  "现有内部后台采用标准列表页 + 详情页 + 表单页模式，可直接复用现有导航、表格、状态标签、表单、日期时间选择器、分群选择器、Toast、确认弹窗和操作记录组件；活动模块在这一基线上扩展，不新增全局页面模式。",
  "保存草稿只保存并展示成功或失败反馈，不自动执行发布前校验。运营点击“校验并预览”时执行校验；任何校验失败都保留草稿，只阻止预览和发布。"
].join("\n");
const prdProductDecisionResolution = [
  "统一确认 PRD 回流的产品规则：",
  "1. 活动模块向用户分群传 segmentId，向公告与定时任务传 activityId、revisionId、标题、规则文案、分群ID、开始时间和结束时间；只在发布或修订发布时创建或更新公告与定时任务。活动服务负责发布编排、幂等键、失败补偿与对账，现有公告和定时任务能力负责各自任务执行。",
  "2. V0 页面包括后台活动列表、活动配置工作台、只读发布预览、已发布快照/版本详情和详情内基础操作记录；入口位于现有运营后台导航。列表展示草稿、待发布、发布中、发布失败、已发布、已结束，并支持新建、继续编辑、查看和编辑已发布活动。",
  "3. 持久状态采用 DRAFT、READY_TO_PUBLISH、PUBLISHING、PUBLISH_FAILED、PUBLISHED、ENDED、REVISION_DRAFT。校验通过后为 READY_TO_PUBLISH；发布失败保留草稿内容并进入 PUBLISH_FAILED，可幂等重试；成功后进入 PUBLISHED 并生成快照。",
  "4. 标题 1-100 字，规则文案 1-5000 字；统一 Asia/Shanghai；开始时间不得早于当前时间且必须早于结束时间；V0 只允许选择一个分群，分群必须存在、启用且当前运营角色有引用权限。",
  "5. 保存草稿只保存，不自动校验；点击‘校验并预览’执行校验，全部通过才进入预览；草稿任何修改都会使旧校验和预览失效；确认发布前服务端再次强制校验。",
  "6. 修订发布成功后替换当前生效版本并更新公告与定时任务，旧快照永久保留。活动结束前允许创建和发布修订草稿；已结束活动只能新建活动，不能发布修订。",
  "7. 活动运营专员和后台管理员可在活动详情查看操作记录。每条记录包含操作类型、操作人、操作时间、activityId、revisionId、执行结果和失败原因。",
  "请解决所有来自 PRD 的 Product Decision 待确认项，更新 Product Solution 并完成 Ready 评估。"
].join("\n");

const cleanRuntimeRun = process.argv.includes("--clean-runtime");
const baselineReportPath = resolve(process.cwd(), "reports", "v0-mainflow-acceptance.json");
const reportPath = resolve(process.cwd(), "reports", cleanRuntimeRun ? "runtime-efficiency-clean.json" : "v0-mainflow-acceptance.json");
const resumeRun = process.argv.includes("--resume");
const previousReport = resumeRun ? JSON.parse(await readFile(reportPath, "utf8")) : undefined;
const runId = previousReport?.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
const dataDirectory = previousReport?.dataDirectory ?? resolve(process.cwd(), ".tmp", "v0-mainflow-acceptance", runId);
const providerEvents: ProviderEvent[] = previousReport?.providerEvents ?? [];
const milestones: Array<Record<string, unknown>> = previousReport?.milestones ?? [];
let activeProviderLabel = "Unattributed";
const realProvider = createAIProvider().provider;
const measuredProvider: AIProvider = {
  async generate(request) {
    const startedAt = performance.now();
    const event: ProviderEvent = {
      index: providerEvents.length + 1,
      stage: activeProviderLabel,
      toolNames: [...request.toolNames],
      startedAt: new Date().toISOString(),
      durationMs: 0,
      status: "FAILED"
    };
    providerEvents.push(event);
    try {
      const response = await realProvider.generate(request);
      event.durationMs = round(performance.now() - startedAt);
      event.status = "COMPLETED";
      event.callNames = response.calls.map(call => call.name);
      event.callArguments = response.calls.map(call => call.arguments);
      event.inputTokens = response.observability?.inputTokens ?? null;
      event.outputTokens = response.observability?.outputTokens ?? null;
      event.cachedInputTokens = response.observability?.cachedInputTokens ?? null;
      event.reasoningTokens = response.observability?.reasoningTokens ?? null;
      event.retryCount = response.observability?.retryCount ?? 0;
      console.log(`[provider ${event.index}] ${event.toolNames.join(",")} completed in ${event.durationMs}ms`);
      await checkpoint();
      return response;
    } catch (error) {
      event.durationMs = round(performance.now() - startedAt);
      event.error = error instanceof Error ? error.message : String(error);
      await checkpoint(event.error);
      throw error;
    }
  }
};

interface ProviderEvent {
  index: number;
  stage: string;
  toolNames: string[];
  startedAt: string;
  durationMs: number;
  status: "COMPLETED" | "FAILED";
  callNames?: string[];
  callArguments?: string[];
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  retryCount?: number;
  error?: string;
}

type AppBundle = Awaited<ReturnType<typeof createApp>>;
let currentBundle: AppBundle | undefined;
let projectId = previousReport?.projectId ?? "";

async function createApp() {
  const repo = new FileProjectRepository(dataDirectory);
  const app = Fastify({ logger: true });
  await app.register(projectRoutes, {
    repo,
    runtime: new RuntimeService(repo, measuredProvider),
    prd: new PrdService(repo, measuredProvider),
    interaction: new InteractionService(repo, measuredProvider),
    figmaPrompt: new FigmaPromptService(repo, measuredProvider)
  });
  return { app, repo };
}

async function restartApp() {
  await currentBundle?.app.close();
  currentBundle = await createApp();
  return currentBundle;
}

async function api(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) {
  assert.ok(currentBundle);
  const bundle = currentBundle;
  const response = await bundle.app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} ${url} failed: ${response.statusCode} ${response.body}`);
  }
  return response.statusCode === 204 ? null : response.json();
}

async function callMeasured(label: string, action: () => Promise<any>, expectedMin: number, expectedMax: number) {
  const before = providerEvents.length;
  const startedAt = performance.now();
  const previousLabel = activeProviderLabel;
  activeProviderLabel = label;
  try {
    const result = await action();
    const providerCalls = providerEvents.length - before;
    assert.ok(providerCalls >= expectedMin && providerCalls <= expectedMax, `${label} expected ${expectedMin}-${expectedMax} Provider calls, received ${providerCalls}`);
    milestones.push({ label, durationMs: round(performance.now() - startedAt), providerCalls });
    await checkpoint();
    return result;
  } finally {
    activeProviderLabel = previousLabel;
  }
}

async function getProject(): Promise<ProjectRecord> {
  return api("GET", `/projects/${projectId}`) as Promise<ProjectRecord>;
}

async function checkpoint(error?: string) {
  await mkdir(resolve(process.cwd(), "reports"), { recursive: true });
  await writeFile(reportPath, JSON.stringify({
    runAt: new Date().toISOString(),
    runId,
    projectId: projectId || undefined,
    dataDirectory,
    status: error ? "FAILED" : "RUNNING",
    error,
    providerEvents,
    milestones
  }, null, 2), "utf8");
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

async function reachDiscoveryReady(project: ProjectRecord) {
  let current = project;
  for (const content of discoveryFollowups) {
    if (current.workflow.stages.DISCOVERY.status === "READY_FOR_CONFIRMATION") break;
    const result = await callMeasured("Discovery follow-up", () => api("POST", `/projects/${projectId}/messages`, { content }), 1, 2);
    current = result.project;
  }
  assert.equal(current.workflow.stages.DISCOVERY.status, "READY_FOR_CONFIRMATION", "Discovery did not become ready within acceptance inputs");
  return current;
}

async function reachSolutionReady(project: ProjectRecord) {
  let current = project;
  const hasPrdDecisionQuestions = current.productSpec.openQuestions.some(question =>
    question.ownerStage === "SOLUTION" && question.status === "OPEN" && question.source?.type === "GENERATION" && question.source.artifact === "PRD"
  );
  if (hasPrdDecisionQuestions) {
    const result = await callMeasured("Resolve PRD Product Decisions", () => api("POST", `/projects/${projectId}/messages`, { content: prdProductDecisionResolution }), 1, 2);
    current = result.project;
    assert.equal(current.workflow.stages.SOLUTION.status, "READY_FOR_CONFIRMATION", "PRD decision resolution did not make Product Solution ready");
    return current;
  }
  const recordedSolutionDecisions = current.productSpec.decisions.filter(item => item.stage === "SOLUTION" && item.status === "ACTIVE").length;
  const remainingInputs = recordedSolutionDecisions > 0 ? solutionDecisions.slice(1) : solutionDecisions;
  for (const content of remainingInputs) {
    if (current.workflow.stages.SOLUTION.status === "READY_FOR_CONFIRMATION") break;
    const result = await callMeasured("Solution decision", () => api("POST", `/projects/${projectId}/messages`, { content }), 1, 2);
    current = result.project;
  }
  assert.equal(current.workflow.stages.SOLUTION.status, "READY_FOR_CONFIRMATION", "Product Solution did not become ready within acceptance inputs");
  return current;
}

try {
  await mkdir(dataDirectory, { recursive: true });
  await checkpoint();
  await restartApp();

  let project: ProjectRecord;
  let result: any;
  if (resumeRun) {
    project = await getProject();
    assert.equal(project.workflow.stages.DISCOVERY.status, "CONFIRMED", "Resume project has not confirmed Discovery");
    assert.ok(["NOT_STARTED", "IN_PROGRESS", "READY_FOR_CONFIRMATION", "CONFIRMED"].includes(project.workflow.stages.SOLUTION.status), "Resume project cannot continue Product Solution");
    milestones.push({ label: "Resume persisted project", providerCalls: 0, recordVersion: project.recordVersion });
  } else {
    const created = await api("POST", "/projects", { name: "V0 Mainflow Acceptance", initialRequirement });
    projectId = created.id;
    assert.equal(providerEvents.length, 0, "Create Project must not call the model");

    result = await callMeasured("Initial Discovery request", () => api("POST", `/projects/${projectId}/messages`, { content: initialRequirement }), 1, 2);
    project = await reachDiscoveryReady(result.project);
    const initialUserMessages = project.messages.filter(message => message.role === "user" && message.content === initialRequirement);
    assert.equal(initialUserMessages.length, 1, "Initial Requirement was appended to conversation more than once");

    await api("POST", `/projects/${projectId}/stages/discovery/confirm`, {});
    project = await getProject();
    assert.equal(project.workflow.stages.DISCOVERY.status, "CONFIRMED");

    result = await callMeasured("Start Product Solution", () => api("POST", `/projects/${projectId}/stages/solution/start`, {}), 1, 2);
    project = result.project;
  }
  if (project.workflow.stages.SOLUTION.status === "NOT_STARTED") {
    result = await callMeasured("Start Product Solution", () => api("POST", `/projects/${projectId}/stages/solution/start`, {}), 1, 2);
    project = result.project;
  }
  if (project.workflow.stages.SOLUTION.status === "IN_PROGRESS") project = await reachSolutionReady(project);
  if (project.workflow.stages.SOLUTION.status === "READY_FOR_CONFIRMATION") {
    await api("POST", `/projects/${projectId}/stages/solution/confirm`, {});
    project = await getProject();
  }
  assert.equal(project.workflow.stages.SOLUTION.status, "CONFIRMED");

  const beforeRestart = structuredClone(project);
  await restartApp();
  project = await getProject();
  assert.equal(project.recordVersion, beforeRestart.recordVersion, "Record version changed during restart");
  assert.deepEqual(project.productSpec, beforeRestart.productSpec, "Product Spec changed during restart");
  assert.equal(project.workflow.stages.SOLUTION.status, "CONFIRMED", "Confirmed Solution was not restored");
  milestones.push({ label: "Restart after Solution", providerCalls: 0, recordVersion: project.recordVersion });

  if (project.artifacts.prd.lifecycleStatus !== "CURRENT" || project.artifacts.prd.reviewStatus === "NOT_STARTED") {
    result = await callMeasured("PRD Meta + Generation", () => api("POST", `/projects/${projectId}/artifacts/prd/generate`, {}), 2, 3);
    project = result.project;
  }
  if (project.artifacts.prd.reviewStatus === "BLOCKED" && project.artifacts.prd.openQuestions.length > 0) {
    assert.ok(project.artifacts.prd.openQuestions.every(question => question.scope === "ARTIFACT_DETAIL"), "PRD contains Product Decision questions and must return to Solution");
    result = await callMeasured("PRD clarification generation", () => api("POST", `/projects/${projectId}/artifacts/prd/clarify`, { answer: prdClarification }), 1, 2);
    project = result.project;
  }
  assert.equal(project.artifacts.prd.lifecycleStatus, "CURRENT", `PRD generation blocked: ${project.artifacts.prd.blockingIssues.join("; ")}`);
  assert.equal(project.artifacts.prd.reviewStatus, "DRAFT");
  assert.ok(project.artifacts.prd.currentContent?.includes("活动"), "Generated PRD lost the confirmed activity context");
  assert.equal(new Set(project.artifacts.prd.selectedPromptIds).size, project.artifacts.prd.selectedPromptIds.length, "PRD selected duplicate Prompt IDs");

  const reviewedPrd = `${project.artifacts.prd.currentContent}\n\n<!-- V0_ACCEPTANCE_PRD_REVIEWED -->`;
  result = await api("PATCH", `/projects/${projectId}/artifacts/prd`, { content: reviewedPrd });
  project = result.project;
  assert.equal(project.artifacts.prd.reviewStatus, "DRAFT");
  result = await api("POST", `/projects/${projectId}/artifacts/prd/confirm`, {});
  project = result.project;
  assert.equal(project.artifacts.prd.reviewStatus, "CONFIRMED");

  result = await callMeasured("Interaction Generation", () => api("POST", `/projects/${projectId}/artifacts/interaction/generate`, {}), 1, 2);
  project = result.project;
  if (project.artifacts.interaction.reviewStatus === "BLOCKED" && project.artifacts.interaction.openQuestions.length > 0) {
    assert.ok(project.artifacts.interaction.openQuestions.every(question => question.scope === "ARTIFACT_DETAIL"), "Interaction still contains an unresolved Product Decision question");
    result = await callMeasured("Interaction clarification generation", () => api("POST", `/projects/${projectId}/artifacts/interaction/clarify`, { answer: interactionClarification }), 1, 2);
    project = result.project;
  }
  assert.equal(project.artifacts.interaction.lifecycleStatus, "CURRENT", `Interaction blocked: ${project.artifacts.interaction.blockingIssues.join("; ")}`);
  assert.equal(project.artifacts.interaction.reviewStatus, "DRAFT");
  const reviewedInteraction = `${project.artifacts.interaction.currentContent}\n\n<!-- V0_ACCEPTANCE_INTERACTION_REVIEWED -->`;
  result = await api("PATCH", `/projects/${projectId}/artifacts/interaction`, { content: reviewedInteraction });
  project = result.project;
  result = await api("POST", `/projects/${projectId}/artifacts/interaction/confirm`, {});
  project = result.project;
  assert.equal(project.artifacts.interaction.reviewStatus, "CONFIRMED");

  result = await callMeasured("Figma Meta + deterministic assembly", () => api("POST", `/projects/${projectId}/artifacts/figma-prompt/generate`, {}), 1, 1);
  project = result.project;
  assert.equal(project.artifacts.figmaPrompt.lifecycleStatus, "CURRENT", `Figma Prompt blocked: ${project.artifacts.figmaPrompt.blockingIssues.join("; ")}`);
  assert.equal(project.artifacts.figmaPrompt.reviewStatus, "DRAFT");
  assert.ok(project.artifacts.figmaPrompt.currentContent?.includes("V0_ACCEPTANCE_PRD_REVIEWED"), "Figma Prompt lost the reviewed PRD content");
  assert.ok(project.artifacts.figmaPrompt.currentContent?.includes("V0_ACCEPTANCE_INTERACTION_REVIEWED"), "Figma Prompt lost the reviewed Interaction content");
  assert.equal(new Set(project.artifacts.figmaPrompt.selectedPromptIds).size, project.artifacts.figmaPrompt.selectedPromptIds.length, "Figma selected duplicate Prompt IDs");

  const reviewedFigma = `${project.artifacts.figmaPrompt.currentContent}\n\n<!-- V0_ACCEPTANCE_FIGMA_REVIEWED -->`;
  result = await api("PATCH", `/projects/${projectId}/artifacts/figma-prompt`, { content: reviewedFigma });
  project = result.project;
  result = await api("POST", `/projects/${projectId}/artifacts/figma-prompt/confirm`, {});
  project = result.project;
  assert.equal(project.artifacts.figmaPrompt.reviewStatus, "CONFIRMED");

  await restartApp();
  project = await getProject();
  assert.ok(project.artifacts.prd.currentContent?.includes("V0_ACCEPTANCE_PRD_REVIEWED"), "PRD edit was lost after restart");
  assert.ok(project.artifacts.interaction.currentContent?.includes("V0_ACCEPTANCE_INTERACTION_REVIEWED"), "Interaction edit was lost after restart");
  assert.ok(project.artifacts.figmaPrompt.currentContent?.includes("V0_ACCEPTANCE_FIGMA_REVIEWED"), "Figma edit was lost after restart");
  assert.equal(project.artifacts.prd.reviewStatus, "CONFIRMED");
  assert.equal(project.artifacts.interaction.reviewStatus, "CONFIRMED");
  assert.equal(project.artifacts.figmaPrompt.reviewStatus, "CONFIRMED");
  const listed = await api("GET", "/projects");
  assert.ok(listed.projects.some((item: { id: string }) => item.id === projectId), "Reloaded project is missing from project history");
  milestones.push({ label: "Restart after complete workflow", providerCalls: 0, recordVersion: project.recordVersion });

  const revisedPrd = `${project.artifacts.prd.currentContent}\n\n<!-- V0_ACCEPTANCE_PRD_CHANGED -->`;
  result = await api("PATCH", `/projects/${projectId}/artifacts/prd`, { content: revisedPrd });
  project = result.project;
  assert.equal(project.artifacts.figmaPrompt.lifecycleStatus, "STALE", "PRD edit did not invalidate Figma Prompt");
  assert.equal(project.artifacts.interaction.lifecycleStatus, "STALE", "PRD edit did not invalidate Interaction Specification");

  assert.ok(currentBundle);
  const finalBundle = currentBundle;
  const mutable = await finalBundle.repo.getById(projectId);
  assert.ok(mutable);
  markStageContentChanged(mutable, "SOLUTION");
  await finalBundle.repo.save(mutable);
  await restartApp();
  project = await getProject();
  assert.equal(project.artifacts.prd.lifecycleStatus, "STALE", "Solution change did not invalidate PRD");
  assert.equal(project.artifacts.figmaPrompt.lifecycleStatus, "STALE", "Solution change did not preserve Figma Prompt invalidation");
  assert.equal(project.workflow.stages.SOLUTION.status, "IN_PROGRESS", "Changed confirmed Solution was not reopened");

  const slowCalls = providerEvents.filter(event => event.durationMs > 180_000);
  const normalCallsByMilestone: Record<string, number> = {
    "PRD Meta + Generation": 2,
    "PRD clarification generation": 1,
    "Interaction Generation": 1,
    "Interaction clarification generation": 1
  };
  const unexpectedAdditionalCalls = milestones.reduce((total, milestone) => {
    const calls = typeof milestone.providerCalls === "number" ? milestone.providerCalls : 0;
    const label = String(milestone.label ?? "");
    const expected = normalCallsByMilestone[label] ?? (calls > 0 ? 1 : 0);
    return total + Math.max(0, calls - expected);
  }, 0);
  const generationRepairCalls = milestones.reduce((total, milestone) => {
    const label = String(milestone.label ?? "");
    if (!(label in normalCallsByMilestone)) return total;
    const calls = typeof milestone.providerCalls === "number" ? milestone.providerCalls : 0;
    return total + Math.max(0, calls - normalCallsByMilestone[label]);
  }, 0);
  const productDecisionReturnCount = project.productSpec.openQuestions.filter(question =>
    question.source?.type === "GENERATION" && question.resolutionMethod === "PRODUCT_DECISION"
  ).length;
  const tokenUsageByStage = Object.entries(providerEvents.reduce<Record<string, { calls: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; providerDurationMs: number }>>((summary, event) => {
    const current = summary[event.stage] ?? { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, providerDurationMs: 0 };
    current.calls += 1;
    current.inputTokens += event.inputTokens ?? 0;
    current.outputTokens += event.outputTokens ?? 0;
    current.cachedInputTokens += event.cachedInputTokens ?? 0;
    current.providerDurationMs += event.durationMs;
    summary[event.stage] = current;
    return summary;
  }, {})).map(([stage, value]) => ({ stage, ...value }));
  let baseline: Record<string, unknown> | undefined;
  if (cleanRuntimeRun) {
    try {
      const parsed = JSON.parse(await readFile(baselineReportPath, "utf8"));
      baseline = {
        report: baselineReportPath,
        providerCallCount: parsed.providerCallCount,
        unexpectedAdditionalCallCount: parsed.unexpectedAdditionalCallCount,
        totalInputTokens: Array.isArray(parsed.providerEvents) ? parsed.providerEvents.reduce((total: number, event: ProviderEvent) => total + (event.inputTokens ?? 0), 0) : undefined,
        totalProviderDurationMs: parsed.totalProviderDurationMs,
        slowCallCount: parsed.slowCallCount,
        failedProviderCallCount: parsed.failedProviderCallCount
      };
    } catch {
      baseline = { report: baselineReportPath, unavailable: true };
    }
  }
  const finalReport = {
    runAt: new Date().toISOString(),
    runId,
    projectId,
    dataDirectory,
    status: "PASSED",
    providerCallCount: providerEvents.length,
    unexpectedAdditionalCallCount: unexpectedAdditionalCalls,
    failedProviderCallCount: providerEvents.filter(event => event.status === "FAILED").length,
    slowCallCount: slowCalls.length,
    totalInputTokens: providerEvents.reduce((total, event) => total + (event.inputTokens ?? 0), 0),
    totalOutputTokens: providerEvents.reduce((total, event) => total + (event.outputTokens ?? 0), 0),
    totalProviderDurationMs: round(providerEvents.reduce((total, event) => total + event.durationMs, 0)),
    providerRetryCount: providerEvents.reduce((total, event) => total + (event.retryCount ?? 0), 0),
    generationRepairCallCount: generationRepairCalls,
    productDecisionReturnCount,
    tokenUsageByStage,
    ...(baseline ? { baseline } : {}),
    providerEvents,
    milestones,
    finalState: {
      discovery: project.workflow.stages.DISCOVERY.status,
      solution: project.workflow.stages.SOLUTION.status,
      prd: `${project.artifacts.prd.lifecycleStatus}/${project.artifacts.prd.reviewStatus}`,
      interaction: `${project.artifacts.interaction.lifecycleStatus}/${project.artifacts.interaction.reviewStatus}`,
      figmaPrompt: `${project.artifacts.figmaPrompt.lifecycleStatus}/${project.artifacts.figmaPrompt.reviewStatus}`,
      recordVersion: project.recordVersion
    }
  };
  await writeFile(reportPath, JSON.stringify(finalReport, null, 2), "utf8");
  console.log(JSON.stringify(finalReport, null, 2));
} catch (error) {
  await checkpoint(error instanceof Error ? error.stack ?? error.message : String(error));
  throw error;
} finally {
  await currentBundle?.app.close();
}
