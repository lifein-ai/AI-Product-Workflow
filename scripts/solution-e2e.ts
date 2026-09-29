import "../src/config/load-env.js";
import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { createAIProvider } from "../src/ai/provider-factory.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";
import { executeTool } from "../src/tools/executor.js";
import { confirmStage } from "../src/workflow/state-machine.js";
import { stageRegistry } from "../src/workflow/stage-registry.js";

const discoveryBackground = "主播 1v1 PK 已上线，但使用率较低，希望促进主播使用 PK，并验证 PK 是否能带动礼物流水。";
const project = createProjectRecord("Creator PK Product Solution", discoveryBackground);
executeTool(project, "update_product_spec", {
  expectedRevision: 0,
  summary: "Confirmed Creator PK Discovery",
  operations: [
    { op: "REPLACE", path: "discovery.background", value: { context: discoveryBackground, whyNow: "功能已上线但使用率较低" } },
    { op: "REPLACE", path: "discovery.problem", value: { statement: "低并发平台中，目标主播难以发现并找到可参与 PK 的对手", impact: ["PK 参与主播数和成局数偏低"] } },
    { op: "ADD", path: "discovery.users.primary", value: { id: "creator", name: "稳定开播但很少使用 PK 的主播" } },
    { op: "ADD", path: "discovery.scenarios", value: { id: "live-pk", actorId: "creator", context: "主播开播并考虑发起 1v1 PK 时", goal: "快速找到合适对手并完成 PK", currentProblem: "同时在线主播少且找对手困难" } },
    { op: "REPLACE", path: "discovery.goals.primary", value: "提高目标主播的 1v1 PK 参与率" },
    { op: "ADD", path: "discovery.goals.secondary", value: "验证参与 PK 是否带动礼物流水" },
    { op: "REPLACE", path: "discovery.behaviorChange", value: { targetBehavior: "目标主播发起或接受并完成 1v1 PK", basis: { type: "EVIDENCED_FRICTION", friction: "低并发时难以找到可参与的对手", evidence: ["主播反馈找对手困难", "当前同时在线主播供给有限"] } } },
    { op: "ADD", path: "discovery.currentProduct.capabilities", value: ["主播邀请对手并接受后进入 PK", "记录发起、接受、完成和礼物流水"] },
    { op: "REPLACE", path: "discovery.currentProduct.currentFlow", value: "主播从对方资料或直播间发起邀请，对方接受后开始 PK" },
    { op: "ADD", path: "discovery.currentProduct.limitations", value: "没有随机匹配，低并发时对手可得性不足" },
    { op: "REPLACE", path: "discovery.direction", value: { summary: "优先提高对手可得性与组局成功率，并以实验验证参与和礼物变化", rationale: ["对应已确认核心阻力"] } },
    { op: "ADD", path: "discovery.scope.mustSolve", value: ["促进目标主播参与 PK", "验证参与和礼物流水变化"] }
  ]
});
executeTool(project, "evaluate_stage", {
  expectedRevision: project.productSpec.version.revision,
  criteria: stageRegistry.DISCOVERY.exitCriteriaIds.map(criterionId => ({
    criterionId,
    status: criterionId === "constraint_clarity" ? "NOT_APPLICABLE" : "SUFFICIENT",
    reason: "Confirmed E2E handoff"
  })),
  blockingUnknownIds: [], summary: "Discovery is sufficient for Product Solution"
});
confirmStage(project, "DISCOVERY");

const repo = new InMemoryProjectRepository();
await repo.create(project);
const realProvider = createAIProvider().provider;
let providerCalls = 0;
const provider: AIProvider = { async generate(request) { providerCalls += 1; return realProvider.generate(request); } };
const app = Fastify({ logger: false });
await app.register(projectRoutes, { repo, runtime: new RuntimeService(repo, provider) });

const turns: Array<Record<string, unknown>> = [];
const userRefinements = [
  "基于你提出的初始方案，我确认首期以提高组局成功率为核心，同时采用轻量阶段任务作为辅助激励。范围包含可用对手曝光、发起/接受/完成任务、固定预算奖励池和参与及礼物指标验证；不包含随机匹配重构、直播间视觉重做、复杂排行榜和长期成长体系。关键规则采用同层级主播优先、完成有效 PK 才计任务、异常对刷不计奖励、奖励池封顶。主流程为主播看到活动与可用对手、发起或接受、完成 PK、进度更新、满足条件领取奖励、平台比较参与和礼物指标。Trade-off 选择固定预算和轻激励，接受激励强度较低但成本可控；风险是假参与和低并发，分别通过有效局规则和分时段对手曝光缓解。请记录这些明确选择，并只保留真正阻塞落地的问题。",
  "对于当前仍阻塞的问题，本轮 V0 统一决定：奖励预算采用固定总池并按有效完成局数分档；目标主播限已有稳定开播但近 30 天 PK 使用较少者；同层级优先只是推荐排序，不承诺实时匹配；礼物流水作为次要实验指标，不作为奖励条件。以上作为本轮明确 Product Decision。若其余未知只影响具体参数，请标记为 non-blocking 并完成 Ready 评估。"
];

async function call(path: string, body: Record<string, unknown>) {
  const before = providerCalls;
  const startedAt = performance.now();
  const response = await app.inject({ method: "POST", url: path, headers: { "x-request-id": `solution-e2e-${Date.now().toString(36)}` }, payload: body });
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  if (response.statusCode !== 200) throw new Error(`${response.statusCode}: ${response.body}`);
  return { body: response.json(), durationMs, llmCalls: providerCalls - before };
}

try {
  let result = await call(`/projects/${project.id}/stages/solution/start`, {});
  turns.push({ type: "START", durationMs: result.durationMs, llmCalls: result.llmCalls, assistant: result.body.reply, project: result.body.project });

  for (const content of userRefinements) {
    if (result.body.project.workflow.stages.SOLUTION.status === "READY_FOR_CONFIRMATION") break;
    result = await call(`/projects/${project.id}/messages`, { content });
    turns.push({ type: "DISCUSSION", user: content, durationMs: result.durationMs, llmCalls: result.llmCalls, assistant: result.body.reply, project: result.body.project });
  }

  const finalProject = result.body.project;
  if (finalProject.workflow.stages.SOLUTION.status !== "READY_FOR_CONFIRMATION") {
    throw new Error(`Solution did not become ready: ${JSON.stringify(finalProject.workflow.stages.SOLUTION)}`);
  }
  const confirmed = await app.inject({ method: "POST", url: `/projects/${project.id}/stages/solution/confirm`, payload: {} });
  if (confirmed.statusCode !== 200) throw new Error(`${confirmed.statusCode}: ${confirmed.body}`);
  const saved = await repo.getById(project.id);
  const report = {
    runAt: new Date().toISOString(), discoveryBackground, providerCalls, turns,
    finalStatus: saved?.workflow.stages.SOLUTION.status,
    interactionStatus: saved?.workflow.stages.INTERACTION.status,
    solution: saved?.productSpec.solution,
    openQuestions: saved?.productSpec.openQuestions.filter(item => item.ownerStage === "SOLUTION"),
    decisions: saved?.productSpec.decisions.filter(item => item.stage === "SOLUTION")
  };
  await mkdir("reports", { recursive: true });
  await writeFile("reports/creator-pk-solution-e2e.json", JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    finalStatus: report.finalStatus,
    interactionStatus: report.interactionStatus,
    turns: turns.map(turn => ({ type: turn.type, durationMs: turn.durationMs, llmCalls: turn.llmCalls })),
    providerCalls,
    solutionDecisions: report.decisions?.length,
    solutionOpenQuestions: report.openQuestions?.length
  }, null, 2));
} finally {
  await app.close();
}
