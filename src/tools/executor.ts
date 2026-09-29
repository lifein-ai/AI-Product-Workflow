import { randomUUID } from "node:crypto";
import type { Decision, ProjectRecord, ReadyEvaluation, ReasoningStage } from "../domain/types.js";
import { markStageContentChanged, applyReadyEvaluation } from "../workflow/state-machine.js";
import { stageRegistry } from "../workflow/stage-registry.js";
import { discoverySpecSchema, solutionSpecSchema } from "../domain/product-spec-schema.js";
import { discoveryExitCriteriaIssues } from "../workflow/discovery-exit-criteria.js";
import { solutionExitCriteriaIssues } from "../workflow/solution-exit-criteria.js";
import { reconcileDiscoveryDecisionProjection } from "../workflow/discovery-consistency.js";
import {
  completeDiscoveryTurnSchema,
  evaluateStageSchema,
  manageOpenQuestionSchema,
  recordDecisionSchema,
  requestValidationSchema,
  updateProductSpecSchema
} from "./schemas.js";

const now = () => new Date().toISOString();

export interface ToolExecutionResult {
  success: boolean;
  message: string;
  productSpecRevision: number;
  stageContentVersion: number;
  stageStatus: string;
  data?: unknown;
}

export interface StageTurnExecutionResult {
  assistantResponse: string;
  operationResults: ToolExecutionResult[];
  readyEvaluationResult?: ToolExecutionResult;
  compatibilityWarnings: string[];
}

export function executeStageTurn(
  project: ProjectRecord,
  rawArgs: unknown,
  responseBaseRevision = project.productSpec.version.revision,
  decisionSource?: NonNullable<Decision["source"]>,
  initialCompatibilityWarnings: string[] = []
): StageTurnExecutionResult {
  const input = completeDiscoveryTurnSchema.parse(rawArgs);
  if (input.expectedRevision !== responseBaseRevision) {
    throw new Error(`Stale Product Spec revision: expected ${responseBaseRevision}`);
  }

  const draft = structuredClone(project);
  const decisionReferences = new Map<string, string>();
  const operationResults: ToolExecutionResult[] = [];
  const compatibilityWarnings = [...initialCompatibilityWarnings];

  for (const [operationIndex, operation] of input.operations.entries()) {
    const { kind, ...rawPayload } = operation;
    let result: ToolExecutionResult;
    try {
      const payload = { ...resolveDecisionReferences(rawPayload, decisionReferences), expectedRevision: responseBaseRevision };
      result = executeTool(draft, kind, payload, responseBaseRevision, decisionSource);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isHardStageTurnError(message)) {
        throw new Error(`Operation ${operationIndex + 1} (${kind}) failed: ${message}`, { cause: error });
      }
      compatibilityWarnings.push(`Operation ${operationIndex + 1} (${kind}) was not applied: ${message}`);
      continue;
    }
    operationResults.push(result);

    if (kind === "record_decision" && operation.reference) {
      if (decisionReferences.has(operation.reference)) throw new Error(`Duplicate decision reference: ${operation.reference}`);
      const decisionId = (result.data as { id?: unknown } | undefined)?.id;
      if (typeof decisionId !== "string") throw new Error("Recorded decision did not return an ID");
      decisionReferences.set(operation.reference, decisionId);
    }
  }

  const blockerRepair = reconcileSatisfiedGenerationBlockers(draft, input.readyEvaluation);
  if (blockerRepair) compatibilityWarnings.push(blockerRepair);

  const consistencyRepair = reconcileDiscoveryDecisionProjection(draft);
  if (consistencyRepair.warning) compatibilityWarnings.push(consistencyRepair.warning);

  let readyEvaluationResult: ToolExecutionResult | undefined;
  const stage = draft.workflow.activeStage!;
  // A skipped non-security operation must not suppress the deterministic Ready
  // evaluation. The evaluation already checks canonical completeness, active
  // decisions, and blocking questions, so it can safely keep the stage in
  // progress or mark it ready based on the state that was actually applied.
  if (draft.workflow.stages[stage].status === "IN_PROGRESS") {
    readyEvaluationResult = executeTool(draft, "evaluate_stage", {
      ...input.readyEvaluation,
      expectedRevision: responseBaseRevision
    }, responseBaseRevision);
  }

  Object.assign(project, draft);
  const assistantResponse = compatibilityWarnings.length === 0
    ? input.assistantResponse
    : `${input.assistantResponse}\n\n系统提示：本轮已保存，并应用了能够安全识别的结构化更新；${compatibilityWarnings.length} 项格式差异已自动适配或跳过。当前阶段保持可继续状态。`;
  return { assistantResponse, operationResults, readyEvaluationResult, compatibilityWarnings };
}

function isHardStageTurnError(message: string): boolean {
  return /^(Stale Product Spec revision|Stage .* cannot write path|Unsafe path|Decision affectedPaths must be owned by the active stage|Open question owner must be the active stage|Open question is owned by another stage|Tool .* is not allowed|Unknown tool|No active stage)/.test(message);
}

function reconcileSatisfiedGenerationBlockers(
  project: ProjectRecord,
  evaluation: { criteria: Array<{ status: string }>; blockingUnknownIds: string[]; summary: string }
): string | undefined {
  const stage = project.workflow.activeStage;
  if (stage !== "SOLUTION" || evaluation.blockingUnknownIds.length > 0) return undefined;
  if (!evaluation.criteria.every(item => item.status === "SUFFICIENT" || item.status === "NOT_APPLICABLE")) return undefined;
  if (!/(?:已解决|已经解决|阻塞问题.{0,20}(?:解决|关闭)|resolved|no\s+blocking)/iu.test(evaluation.summary)) return undefined;

  const resolved = project.productSpec.openQuestions.filter(question =>
    question.ownerStage === "SOLUTION"
    && question.status === "OPEN"
    && question.blocking
    && question.source?.type === "GENERATION"
  );
  if (resolved.length === 0) return undefined;

  for (const question of resolved) {
    question.status = "RESOLVED";
    question.resolution = "已由本轮用户补充并写入结构化 Product Solution 规则。";
  }
  touchContent(project, "SOLUTION");
  return `Resolved ${resolved.length} generated Solution blocker(s) from the completed structured rules`;
}

export function executeTool(
  project: ProjectRecord,
  toolName: string,
  rawArgs: unknown,
  responseBaseRevision = project.productSpec.version.revision,
  decisionSource?: NonNullable<Decision["source"]>
): ToolExecutionResult {
  const stage = project.workflow.activeStage;
  if (!stage) throw new Error("No active stage");
  const status = project.workflow.stages[stage].status;
  if (status !== "IN_PROGRESS" && status !== "READY_FOR_CONFIRMATION") {
    throw new Error(`Stage ${stage} is not writable from ${project.workflow.stages[stage].status}`);
  }
  if (!stageRegistry[stage].allowedTools.includes(toolName)) {
    throw new Error(`Tool ${toolName} is not allowed in stage ${stage}`);
  }
  const claimedRevision = (rawArgs as { expectedRevision?: unknown } | null)?.expectedRevision;
  if (claimedRevision !== responseBaseRevision) throw new Error(`Stale Product Spec revision: expected ${responseBaseRevision}`);
  if (toolName === "evaluate_stage" && status !== "IN_PROGRESS") throw new Error("Stage is already ready; only a content change can invalidate it");

  switch (toolName) {
    case "update_product_spec":
      return updateProductSpec(project, stage, rawArgs);
    case "manage_open_question":
      return manageOpenQuestion(project, stage, rawArgs);
    case "record_decision":
      return recordDecision(project, stage, rawArgs, decisionSource);
    case "request_validation":
      return requestValidation(project, stage, rawArgs);
    case "evaluate_stage":
      return evaluateStage(project, stage, rawArgs);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function updateProductSpec(project: ProjectRecord, stage: ReasoningStage, rawArgs: unknown): ToolExecutionResult {
  const input = updateProductSpecSchema.parse(rawArgs);
  const ownedRoot = stageRegistry[stage].ownedRoot;
  const operations = input.operations.map(operation => ({ ...operation, path: normalizeOwnedPath(operation.path, ownedRoot) }));

  for (const operation of operations) {
    if (!operation.path.startsWith(`${ownedRoot}.`)) {
      throw new Error(`Stage ${stage} cannot write path ${operation.path}`);
    }
    if (operation.path.split(".").some(part => !part || ["__proto__", "prototype", "constructor"].includes(part))) {
      throw new Error(`Unsafe path ${operation.path}`);
    }
    if (operation.op !== "REMOVE" && operation.value === undefined) throw new Error(`Value required for ${operation.path}`);
  }

  const draft = structuredClone(project.productSpec) as unknown as Record<string, unknown>;
  for (const operation of operations) {
    applyPathOperation(draft, operation.op, operation.path, operation.value);
  }
  if (stage === "DISCOVERY") {
    normalizeDiscoveryModelShape(draft.discovery);
    discoverySpecSchema.parse(draft.discovery);
  }
  else if (stage === "SOLUTION") solutionSpecSchema.parse(draft.solution);
  else throw new Error(`Stage ${stage} is not implemented`);
  if (JSON.stringify(draft[ownedRoot]) === JSON.stringify(project.productSpec[ownedRoot])) {
    return result(project, stage, "No Product Spec content changed.", { summary: input.summary });
  }

  project.productSpec = draft as unknown as typeof project.productSpec;
  project.productSpec.version.revision += 1;
  project.productSpec.version.updatedAt = now();
  project.productSpec.project.updatedAt = now();
  markStageContentChanged(project, stage);

  return result(project, stage, `Applied ${operations.length} Product Spec operation(s).`, { summary: input.summary });
}

function normalizeDiscoveryModelShape(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const discovery = value as Record<string, unknown>;
  const behaviorChange = discovery.behaviorChange;
  if (behaviorChange && typeof behaviorChange === "object" && !Array.isArray(behaviorChange)) {
    const behavior = behaviorChange as Record<string, unknown>;
    moveAlias(behavior, "targetBehavior", ["target_behavior", "target", "desiredBehavior", "desired_behavior"]);
    const basis = behavior.basis;
    if (basis && typeof basis === "object" && !Array.isArray(basis)) {
      const record = basis as Record<string, unknown>;
      moveAlias(record, "evidenceStatus", ["evidence_status"]);
      moveAlias(record, "decisionId", ["decision_id"]);
      moveAlias(record, "validationIntent", ["validation_intent", "validation", "validationPlan", "validation_plan"]);
      if (typeof record.type === "string") {
        const normalizedType = record.type.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toUpperCase();
        if (["ACCEPTED_ASSUMPTION", "ASSUMPTION", "HYPOTHESIS"].includes(normalizedType)) record.type = "ACCEPTED_ASSUMPTION";
        if (["EVIDENCED_FRICTION", "FRICTION", "EVIDENCE"].includes(normalizedType)) record.type = "EVIDENCED_FRICTION";
      }
      if (typeof record.evidenceStatus === "string") {
        const normalizedStatus = record.evidenceStatus.trim().replace(/[\s-]+/g, "_").toUpperCase();
        if (["UNKNOWN", "NONE", "NO_EVIDENCE", "UNVERIFIED"].includes(normalizedStatus)) record.evidenceStatus = "UNVALIDATED";
        else if (["PARTIAL", "SOME", "WEAK"].includes(normalizedStatus)) record.evidenceStatus = "LIMITED";
        else record.evidenceStatus = normalizedStatus;
      }
      if (record.type === "EVIDENCED_FRICTION" && typeof record.evidence === "string" && record.evidence.trim()) {
        record.evidence = [record.evidence];
      }
    }
  }
  if (!Array.isArray(discovery.constraints)) return;
  for (const constraint of discovery.constraints) {
    if (!constraint || typeof constraint !== "object" || Array.isArray(constraint)) continue;
    const record = constraint as Record<string, unknown>;
    if (typeof record.type !== "string") continue;
    record.type = normalizeConstraintType(record.type);
  }
}

function moveAlias(record: Record<string, unknown>, target: string, aliases: string[]): void {
  if (record[target] !== undefined) return;
  for (const alias of aliases) {
    if (record[alias] === undefined) continue;
    record[target] = record[alias];
    delete record[alias];
    return;
  }
}

function normalizeConstraintType(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[ -]+/g, "_");
  const allowed = new Set(["BUSINESS", "TECHNICAL", "RESOURCE", "VERSION", "COMPLIANCE", "OTHER"]);
  if (allowed.has(normalized)) return normalized;
  const aliases: Record<string, string> = {
    PLATFORM: "TECHNICAL",
    ARCHITECTURE: "TECHNICAL",
    SYSTEM: "TECHNICAL",
    技术: "TECHNICAL",
    平台: "TECHNICAL",
    AUTHORIZATION: "COMPLIANCE",
    PERMISSION: "COMPLIANCE",
    SECURITY: "COMPLIANCE",
    PRIVACY: "COMPLIANCE",
    LEGAL: "COMPLIANCE",
    权限: "COMPLIANCE",
    合规: "COMPLIANCE",
    DELIVERY: "RESOURCE",
    TIME: "RESOURCE",
    TIMELINE: "RESOURCE",
    BUDGET: "RESOURCE",
    TEAM: "RESOURCE",
    交付: "RESOURCE",
    时间: "RESOURCE",
    资源: "RESOURCE",
    RELEASE: "VERSION",
    版本: "VERSION"
  };
  return aliases[normalized] ?? value;
}

function manageOpenQuestion(project: ProjectRecord, stage: ReasoningStage, rawArgs: unknown): ToolExecutionResult {
  const input = manageOpenQuestionSchema.parse(rawArgs);

  if (input.action === "CREATE") {
    if (!input.question || !input.impact || input.blocking === undefined || !input.resolutionMethod) {
      throw new Error("CREATE requires question, impact, blocking and resolutionMethod");
    }
    const item = {
      id: randomUUID(),
      createdInStage: stage,
      ownerStage: input.ownerStage ?? stage,
      question: input.question,
      impact: input.impact,
      blocking: input.blocking,
      resolutionMethod: input.resolutionMethod,
      status: "OPEN" as const
    };
    if (item.ownerStage !== stage) throw new Error("Open question owner must be the active stage");
    project.productSpec.openQuestions.push(item);
    touchContent(project, stage);
    return result(project, stage, "Open question created.", item);
  }

  if (!input.questionId) throw new Error(`${input.action} requires questionId`);
  const item = project.productSpec.openQuestions.find(q => q.id === input.questionId);
  if (!item) throw new Error(`Open question ${input.questionId} not found`);
  if (item.ownerStage !== stage) throw new Error("Open question is owned by another stage");
  if (input.action === "RESOLVE" && item.status === "RESOLVED") {
    if (input.resolution && !item.resolution) item.resolution = input.resolution;
    return result(project, stage, "Question was already resolved; treated as idempotent.", item);
  }
  if (input.action === "DEFER" && item.status === "DEFERRED") {
    return result(project, stage, "Question was already deferred; treated as idempotent.", item);
  }
  if (input.action === "REOPEN" && item.status === "OPEN") {
    return result(project, stage, "Question was already open; treated as idempotent.", item);
  }
  if (input.action === "RESOLVE" && item.status !== "OPEN") throw new Error("Only open questions can be resolved");
  if (input.action === "DEFER" && item.status !== "OPEN") throw new Error("Only open questions can be deferred");

  if (input.action === "RESOLVE") {
    if (!input.resolution) throw new Error("RESOLVE requires resolution");
    item.status = "RESOLVED";
    item.resolution = input.resolution;
  } else if (input.action === "DEFER") {
    item.status = "DEFERRED";
    if (input.resolution) item.resolution = input.resolution;
  } else {
    item.status = "OPEN";
    item.resolution = undefined;
  }
  touchContent(project, stage);
  return result(project, stage, `Open question ${input.action.toLowerCase()}d.`, item);
}

function recordDecision(
  project: ProjectRecord,
  stage: ReasoningStage,
  rawArgs: unknown,
  decisionSource?: NonNullable<Decision["source"]>
): ToolExecutionResult {
  const input = recordDecisionSchema.parse(rawArgs);
  const ownedRoot = stageRegistry[stage].ownedRoot;
  const affectedPaths = input.affectedPaths.map(normalizePath);
  if (affectedPaths.some(path => !path.startsWith(`${ownedRoot}.`))) {
    throw new Error("Decision affectedPaths must be owned by the active stage");
  }
  const previous = input.supersedesDecisionId
    ? project.productSpec.decisions.find(d => d.id === input.supersedesDecisionId)
    : undefined;
  if (input.supersedesDecisionId && (!previous || previous.stage !== stage || previous.status !== "ACTIVE")) {
    throw new Error(`Active decision ${input.supersedesDecisionId} not found in stage ${stage}`);
  }
  const duplicate = project.productSpec.decisions.find(d => d.stage === stage && d.status === "ACTIVE" && d.decision === input.decision);
  if (duplicate) {
    if (!previous) return result(project, stage, "Identical active decision already exists.", duplicate);
    if (duplicate.id === previous.id) throw new Error("A decision cannot supersede itself");
    previous.status = "SUPERSEDED";
    previous.supersededBy = duplicate.id;
    previous.updatedAt = now();
    duplicate.supersedesDecisionId ??= previous.id;
    touchContent(project, stage);
    return result(project, stage, "Existing decision linked to superseded decision.", duplicate);
  }
  if (previous) {
    previous.status = "SUPERSEDED";
    previous.updatedAt = now();
  }
  const timestamp = now();
  const item = {
    id: randomUUID(),
    stage,
    decision: input.decision,
    rationale: input.rationale,
    affectedPaths,
    status: input.status ?? "ACTIVE" as const,
    source: decisionSource ?? { type: "SYSTEM" as const },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(input.supersedesDecisionId ? { supersedesDecisionId: input.supersedesDecisionId } : {})
  };
  project.productSpec.decisions.push(item);
  if (previous) previous.supersededBy = item.id;
  touchContent(project, stage);
  return result(project, stage, "Decision recorded.", item);
}

function requestValidation(project: ProjectRecord, stage: ReasoningStage, rawArgs: unknown): ToolExecutionResult {
  const input = requestValidationSchema.parse(rawArgs);
  if (input.relatedOpenQuestionId && !project.productSpec.openQuestions.some(q => q.id === input.relatedOpenQuestionId && q.ownerStage === stage)) {
    throw new Error("Related open question not found in active stage");
  }
  // V0: validation request is represented as an open question; execution comes later.
  const item = {
    id: randomUUID(),
    createdInStage: stage,
    ownerStage: stage,
    question: input.question,
    impact: input.reason,
    blocking: input.blocking,
    resolutionMethod: input.type === "RESEARCH" ? "RESEARCH" as const
      : input.type === "DATA" ? "DATA_VALIDATION" as const
      : input.type === "STAKEHOLDER" ? "STAKEHOLDER_CONFIRMATION" as const
      : "TECHNICAL_VALIDATION" as const,
    status: "OPEN" as const,
    validation: {
      type: input.type,
      ...(input.expectedOutput ? { expectedOutput: input.expectedOutput } : {}),
      ...(input.relatedOpenQuestionId ? { relatedOpenQuestionId: input.relatedOpenQuestionId } : {})
    }
  };
  project.productSpec.openQuestions.push(item);
  touchContent(project, stage);
  return result(project, stage, "Validation request created as an open question.", item);
}

function evaluateStage(project: ProjectRecord, stage: ReasoningStage, rawArgs: unknown): ToolExecutionResult {
  const input = evaluateStageSchema.parse(rawArgs);
  const config = stageRegistry[stage];
  const provided = new Map(input.criteria.map(c => [c.criterionId, c]));
  if (provided.size !== input.criteria.length || input.criteria.some(c => !config.exitCriteriaIds.includes(c.criterionId))) {
    throw new Error(`Criteria must contain each configured criterion exactly once: ${config.exitCriteriaIds.join(", ")}`);
  }
  const missingCriteria = config.exitCriteriaIds.filter(id => !provided.has(id));

  const blockingOpenIds = new Set(project.productSpec.openQuestions.filter(q => q.ownerStage === stage && q.status === "OPEN" && q.blocking).map(q => q.id));
  const unknownIdsAreCurrent = input.blockingUnknownIds.every(id => blockingOpenIds.has(id));
  const allCriteriaPass = missingCriteria.length === 0 && config.exitCriteriaIds.every(id => {
    const status = provided.get(id)?.status;
    return status === "SUFFICIENT" || status === "NOT_APPLICABLE";
  });
  const runtimeHasBlocking = blockingOpenIds.size > 0;
  const validationIssues = stage === "DISCOVERY"
    ? discoveryExitCriteriaIssues(discoverySpecSchema.parse(project.productSpec.discovery), input.criteria, project.productSpec.decisions)
    : stage === "SOLUTION"
      ? solutionExitCriteriaIssues(solutionSpecSchema.parse(project.productSpec.solution), input.criteria, project.productSpec.decisions)
      : [`Stage ${stage} is not implemented`];
  if (stage === "SOLUTION" && project.workflow.stages.DISCOVERY.status !== "CONFIRMED") {
    validationIssues.push("Discovery must be confirmed before Solution can be Ready");
  }
  if (runtimeHasBlocking) validationIssues.push(`Blocking open questions remain: ${[...blockingOpenIds].join(", ")}`);
  if (!unknownIdsAreCurrent) validationIssues.push("blockingUnknownIds contains IDs that are not current blocking questions");
  const ready = allCriteriaPass && !runtimeHasBlocking && unknownIdsAreCurrent && validationIssues.length === 0;

  const evaluation: ReadyEvaluation = {
    criteria: input.criteria,
    blockingUnknownIds: [...blockingOpenIds],
    result: ready ? "READY" : "NOT_READY",
    summary: input.summary,
    evaluatedContentVersion: project.workflow.stages[stage].contentVersion,
    dependencySnapshot: stage === "SOLUTION"
      ? { DISCOVERY: project.workflow.stages.DISCOVERY.confirmedVersion ?? project.workflow.stages.DISCOVERY.contentVersion }
      : {}
  };
  applyReadyEvaluation(project, stage, evaluation);
  return result(project, stage, `Stage evaluated as ${evaluation.result}.`, { ...evaluation, validationIssues });
}

function touchRevision(project: ProjectRecord): void {
  project.productSpec.version.revision += 1;
  project.productSpec.version.updatedAt = now();
  project.productSpec.project.updatedAt = now();
}

function touchContent(project: ProjectRecord, stage: ReasoningStage): void {
  touchRevision(project);
  markStageContentChanged(project, stage);
}

function result(project: ProjectRecord, stage: ReasoningStage, message: string, data?: unknown): ToolExecutionResult {
  return {
    success: true,
    message,
    productSpecRevision: project.productSpec.version.revision,
    stageContentVersion: project.workflow.stages[stage].contentVersion,
    stageStatus: project.workflow.stages[stage].status,
    data
  };
}

function resolveDecisionReferences<T>(value: T, references: Map<string, string>): T {
  if (typeof value === "string" && value.startsWith("$decision:")) {
    const reference = value.slice("$decision:".length);
    const decisionId = references.get(reference);
    if (!decisionId) throw new Error(`Unknown decision reference: ${reference}`);
    return decisionId as T;
  }
  if (Array.isArray(value)) return value.map(item => resolveDecisionReferences(item, references)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveDecisionReferences(item, references)])) as T;
  }
  return value;
}

function applyPathOperation(root: Record<string, unknown>, op: "ADD" | "REPLACE" | "REMOVE", path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor: any = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cursor[key] === undefined && op !== "REMOVE") {
      cursor[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    if (cursor[key] === undefined) throw new Error(`Parent path for ${path} does not exist`);
    cursor = cursor[key];
    if (cursor === null || typeof cursor !== "object") throw new Error(`Parent path for ${path} is not an object`);
  }
  const key = parts.at(-1)!;
  if (op === "REMOVE") {
    if (Array.isArray(cursor)) {
      const index = Number(key);
      if (!Number.isInteger(index)) throw new Error(`Array path requires numeric index: ${path}`);
      if (index < 0 || index >= cursor.length) throw new Error(`Array index out of range: ${path}`);
      cursor.splice(index, 1);
    } else {
      if (!Object.hasOwn(cursor, key)) throw new Error(`Path ${path} does not exist`);
      delete cursor[key];
    }
    return;
  }

  if (Array.isArray(cursor)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index > cursor.length) throw new Error(`Array index out of range: ${path}`);
    if (index === cursor.length) cursor.push(value);
    else cursor[index] = value;
  } else if (op === "ADD" && Array.isArray(cursor[key])) {
    if (Array.isArray(value)) cursor[key].push(...value);
    else cursor[key].push(value);
  } else {
    cursor[key] = value;
  }
}

function normalizePath(path: string): string {
  const normalized = path.includes("/")
    ? path.replace(/^\//, "").split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~")).join(".")
    : path;
  return normalized.replace(/\[(\d+)\]/g, ".$1");
}

function normalizeOwnedPath(path: string, ownedRoot: string): string {
  const normalized = normalizePath(path);
  const explicitRoots = ["discovery", "solution", "interaction", "workflow", "project", "openQuestions", "decisions", "version"];
  return explicitRoots.some(root => normalized === root || normalized.startsWith(`${root}.`))
    ? normalized
    : `${ownedRoot}.${normalized}`;
}
