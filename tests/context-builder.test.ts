import assert from "node:assert/strict";
import test from "node:test";
import { createProjectRecord } from "../src/domain/factories.js";
import type { Decision, OpenQuestion, ProjectRecord } from "../src/domain/types.js";
import {
  DISCOVERY_CONTEXT_INPUT_BUDGET_TOKENS,
  buildStageContext,
  estimateTokens
} from "../src/runtime/context-builder.js";

const currentInput = [{ role: "user", content: "第一个不要，刚才那个也不要，这个不要，改成后面那个。" }];

function question(index: number, status: OpenQuestion["status"]): OpenQuestion {
  return {
    id: `question-${index}`,
    createdInStage: "DISCOVERY",
    ownerStage: "DISCOVERY",
    question: `Question ${index}`,
    impact: "May affect Discovery direction",
    blocking: status === "OPEN",
    resolutionMethod: "STAKEHOLDER_CONFIRMATION",
    status,
    ...(status === "OPEN" ? {
      validation: { type: "STAKEHOLDER" as const, expectedOutput: "Current stakeholder choice" }
    } : { resolution: `Resolved ${index}` })
  };
}

function decision(index: number, status: Decision["status"]): Decision {
  return {
    id: `decision-${index}`,
    stage: "DISCOVERY",
    decision: `Decision ${index}`,
    rationale: ["Test rationale"],
    affectedPaths: ["discovery.direction"],
    status
  };
}

function appendTurn(project: ProjectRecord, index: number, assistantContent = `Assistant turn ${index}`): void {
  project.messages.push(
    { id: `user-${index}`, role: "user", content: `User turn ${index}`, createdAt: "2026-01-01T00:00:00.000Z", stage: "DISCOVERY" },
    { id: `assistant-${index}`, role: "assistant", content: assistantContent, createdAt: "2026-01-01T00:00:00.000Z", stage: "DISCOVERY" }
  );
}

test("Discovery projection includes only OPEN questions and ACTIVE decisions without mutating repository data", () => {
  const project = createProjectRecord("Lifecycle projection", "Audit context lifecycle filtering");
  project.productSpec.openQuestions.push(...Array.from({ length: 20 }, (_, index) => question(index, "RESOLVED")));
  project.productSpec.openQuestions.push(question(20, "DEFERRED"));
  project.productSpec.openQuestions.push(question(21, "OPEN"));
  project.productSpec.decisions.push(...Array.from({ length: 10 }, (_, index) => decision(index, "SUPERSEDED")));
  project.productSpec.decisions.push(decision(10, "ACTIVE"));
  const before = structuredClone(project.productSpec);

  const context = buildStageContext(project, "DISCOVERY", { input: currentInput });
  const projectedQuestions = context.projection.productSpec.openQuestions as OpenQuestion[];
  const projectedDecisions = context.projection.productSpec.decisions as Decision[];

  assert.deepEqual(projectedQuestions.map(item => item.id), ["question-21"]);
  assert.equal(projectedQuestions[0].validation?.expectedOutput, "Current stakeholder choice");
  assert.deepEqual(projectedDecisions.map(item => item.id), ["decision-10"]);
  assert.deepEqual(project.productSpec, before);
  assert.equal(project.productSpec.openQuestions.length, 22);
  assert.equal(project.productSpec.decisions.length, 11);
  assert.doesNotMatch(context.instructions, /# COMPLETION PROTOCOL|complete_discovery_turn/);
});

test("Solution projection excludes resolved questions and superseded or deferred decisions", () => {
  const project = createProjectRecord("Solution projection", "Audit Solution lifecycle filtering");
  project.workflow.stages.DISCOVERY.status = "CONFIRMED";
  project.workflow.stages.DISCOVERY.confirmedVersion = 0;
  project.workflow.stages.SOLUTION.status = "IN_PROGRESS";
  project.workflow.activeStage = "SOLUTION";
  project.productSpec.openQuestions.push(question(1, "OPEN"), question(2, "RESOLVED"));
  project.productSpec.openQuestions[0].ownerStage = "SOLUTION";
  project.productSpec.openQuestions[1].ownerStage = "SOLUTION";
  project.productSpec.decisions.push(decision(1, "ACTIVE"), decision(2, "SUPERSEDED"));
  project.productSpec.decisions[0].stage = "SOLUTION";
  project.productSpec.decisions[1].stage = "SOLUTION";
  project.productSpec.decisions.push({ ...decision(3, "ACTIVE"), stage: "SOLUTION", status: "DEFERRED" });

  const context = buildStageContext(project, "SOLUTION", { input: currentInput });
  const projected = context.projection.productSpec;
  assert.deepEqual((projected.openQuestions as OpenQuestion[]).map(item => item.id), ["question-1"]);
  assert.deepEqual((projected.decisions as Decision[]).map(item => item.id), ["decision-1"]);
});

test("Discovery conversation projection keeps only the previous complete local turn after 20 turns", () => {
  const project = createProjectRecord("Local references", "Keep enough context for local references");
  for (let index = 1; index <= 20; index += 1) {
    appendTurn(project, index, index === 20
      ? "我刚才给了两个选项：第一个保留原方案，后面那个改成分阶段验证。"
      : `Assistant turn ${index}`);
  }

  const context = buildStageContext(project, "DISCOVERY", { input: currentInput });

  assert.equal(context.conversationMode, "LOCAL_TURN");
  assert.deepEqual(context.projection.recentConversation, [
    { role: "user", content: "User turn 20" },
    { role: "assistant", content: "我刚才给了两个选项：第一个保留原方案，后面那个改成分阶段验证。" }
  ]);
  assert.match(context.instructions, /第一个保留原方案/);
  assert.doesNotMatch(context.instructions, /Assistant turn 19/);
  assert.equal(project.messages.length, 40);
});

test("Discovery budget deterministically removes local conversation before rejecting canonical state", () => {
  const project = createProjectRecord("Budget", "Budget guard");
  appendTurn(project, 1, `两个选项：第一个和后面那个。${"历史内容".repeat(4_000)}`);

  const context = buildStageContext(project, "DISCOVERY", { input: currentInput });

  assert.equal(context.conversationMode, "NONE");
  assert.deepEqual(context.projection.recentConversation, []);
  assert.ok(context.estimatedInputTokens <= DISCOVERY_CONTEXT_INPUT_BUDGET_TOKENS);

  project.productSpec.discovery.hypotheses.push({
    id: "oversized-canonical-state",
    statement: "仍然有效的 canonical state ".repeat(8_000)
  });
  assert.throws(
    () => buildStageContext(project, "DISCOVERY", { input: currentInput }),
    /exceeds estimated input token budget.*after removing conversation history/
  );
});

test("static state plateaus, obsolete lifecycle records do not accumulate, and active state may grow", () => {
  const turns = [1, 5, 10, 20];
  const staticTokens = turns.map(turn => projectedTokens(turn, "STATIC"));
  const obsoleteTokens = turns.map(turn => projectedTokens(turn, "OBSOLETE"));
  const activeTokens = turns.map(turn => projectedTokens(turn, "ACTIVE"));

  assert.ok(Math.abs(staticTokens[3] - staticTokens[1]) < 20, JSON.stringify(staticTokens));
  assert.ok(Math.abs(obsoleteTokens[3] - obsoleteTokens[1]) < 30, JSON.stringify(obsoleteTokens));
  assert.ok(activeTokens[3] > activeTokens[2]);
  assert.ok(activeTokens[2] > activeTokens[1]);
  assert.ok(activeTokens.every(tokens => tokens <= DISCOVERY_CONTEXT_INPUT_BUDGET_TOKENS));
});

function projectedTokens(turn: number, scenario: "STATIC" | "OBSOLETE" | "ACTIVE"): number {
  const project = createProjectRecord(`Accumulation ${scenario}`, "Fixed structured state");
  project.productSpec.discovery.problem = { statement: "Creators cannot see review progress" };
  project.productSpec.discovery.goals.primary = "Reduce repeated support requests";

  for (let index = 1; index < turn; index += 1) {
    appendTurn(project, index);
    if (scenario === "OBSOLETE") {
      project.productSpec.openQuestions.push(question(index, "RESOLVED"));
      project.productSpec.decisions.push(decision(index, "SUPERSEDED"));
    }
    if (scenario === "ACTIVE") {
      project.productSpec.openQuestions.push(question(index, "OPEN"));
      project.productSpec.decisions.push(decision(index, "ACTIVE"));
    }
  }
  if (scenario === "OBSOLETE") {
    project.productSpec.openQuestions.push(question(10_000, "OPEN"));
    project.productSpec.decisions.push(decision(10_000, "ACTIVE"));
  }

  return buildStageContext(project, "DISCOVERY", { input: currentInput }).estimatedInputTokens;
}

test("deterministic estimator remains stable for mixed CJK and Latin text", () => {
  assert.equal(estimateTokens("四个中文"), 4);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("中文abcd"), 3);
});
