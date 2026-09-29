import type { ProjectRecord, ReasoningStage } from "../domain/types.js";
import { stageRegistry } from "../workflow/stage-registry.js";

export interface AdaptedStageTurn {
  args: Record<string, unknown>;
  warnings: string[];
}

export function parseAndAdaptStageTurn(
  rawArguments: string,
  fallbackText: string,
  project: ProjectRecord,
  stage: ReasoningStage,
  responseBaseRevision: number
): AdaptedStageTurn {
  const warnings: string[] = [];
  const raw = parseFlexibleJson(rawArguments || fallbackText);
  const input = asRecord(raw, "Stage turn must be a JSON object");
  const config = stageRegistry[stage];

  const expectedRevision = toInteger(readAlias(input, ["expectedRevision", "expected_revision", "revision"]));
  if (expectedRevision === undefined) warnings.push("expectedRevision was missing and was restored from the request snapshot");
  else if (expectedRevision !== responseBaseRevision) warnings.push("expectedRevision differed from the request snapshot and was safely corrected");

  const assistantResponse = firstNonEmptyString(
    readAlias(input, ["assistantResponse", "assistant_response", "response", "reply", "message"]),
    fallbackText
  ) ?? "已收到并处理本轮信息。";

  const rawOperations = toArray(readAlias(input, ["operations", "ops", "actions"]));
  if (rawOperations.length > 20) warnings.push(`Only the first 20 of ${rawOperations.length} operations were considered`);
  const operations = rawOperations.slice(0, 20)
    .map((operation, index) => adaptOperation(operation, index, project, stage, warnings))
    .filter((operation): operation is Record<string, unknown> => operation !== null);

  const readyEvaluation = adaptReadyEvaluation(
    readAlias(input, ["readyEvaluation", "ready_evaluation", "evaluation", "readiness"]),
    project,
    stage,
    warnings
  );

  return {
    args: {
      expectedRevision: responseBaseRevision,
      assistantResponse,
      operations,
      readyEvaluation
    },
    warnings
  };
}

function adaptOperation(
  raw: unknown,
  index: number,
  project: ProjectRecord,
  stage: ReasoningStage,
  warnings: string[]
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`operation ${index + 1} was not an object and was ignored`);
    return null;
  }
  const operation = raw as Record<string, unknown>;
  const kind = normalizeKind(readAlias(operation, ["kind", "tool", "toolName", "type"]));
  if (!kind) {
    warnings.push(`operation ${index + 1} had no recognized kind and was ignored`);
    return null;
  }

  if (kind === "update_product_spec") {
    const rawChanges = toArray(readAlias(operation, ["operations", "changes", "patches", "updates"]));
    if (rawChanges.length > 20) warnings.push(`operation ${index + 1} was limited to its first 20 Product Spec changes`);
    const changes = rawChanges.slice(0, 20)
      .map((change, changeIndex) => adaptPathOperation(change, index, changeIndex, warnings))
      .filter((change): change is Record<string, unknown> => change !== null);
    if (changes.length === 0) {
      warnings.push(`operation ${index + 1} contained no usable Product Spec changes and was ignored`);
      return null;
    }
    return {
      kind,
      operations: changes,
      summary: firstNonEmptyString(readAlias(operation, ["summary", "description", "reason"])) ?? "Product Spec update"
    };
  }

  if (kind === "manage_open_question") {
    const action = normalizeQuestionAction(readAlias(operation, ["action", "operation"]));
    const question = firstNonEmptyString(readAlias(operation, ["question", "questionText", "question_text"]));
    let questionId = firstNonEmptyString(readAlias(operation, ["questionId", "question_id", "id"]));
    if (!questionId && action !== "CREATE" && question) {
      const matches = project.productSpec.openQuestions.filter(item => normalizeText(item.question) === normalizeText(question));
      if (matches.length === 1) {
        questionId = matches[0].id;
        warnings.push(`operation ${index + 1} questionId was recovered from its exact question text`);
      }
    }
    const adapted = compact({
      kind,
      action,
      questionId,
      ownerStage: normalizeStage(readAlias(operation, ["ownerStage", "owner_stage"])),
      question,
      impact: firstNonEmptyString(readAlias(operation, ["impact", "reason"])),
      blocking: toBoolean(readAlias(operation, ["blocking", "isBlocking", "is_blocking"])),
      resolutionMethod: normalizeResolutionMethod(readAlias(operation, ["resolutionMethod", "resolution_method", "method"])),
      resolution: firstNonEmptyString(readAlias(operation, ["resolution", "answer"]))
    });
    if (!action || (action === "CREATE" && (!adapted.question || !adapted.impact || adapted.blocking === undefined || !adapted.resolutionMethod))) {
      warnings.push(`operation ${index + 1} open-question action was incomplete and was ignored`);
      return null;
    }
    return adapted;
  }

  if (kind === "record_decision") {
    const adapted = compact({
      kind,
      reference: firstNonEmptyString(readAlias(operation, ["reference", "ref"])),
      decision: firstNonEmptyString(readAlias(operation, ["decision", "choice"])),
      rationale: toStringArray(readAlias(operation, ["rationale", "reasons", "reason"])),
      affectedPaths: toStringArray(readAlias(operation, ["affectedPaths", "affected_paths", "paths"]))
        .map(path => normalizeAffectedPath(path, stage)),
      status: normalizeAllowedEnum(readAlias(operation, ["status"]), ["ACTIVE", "DEFERRED"]),
      supersedesDecisionId: firstNonEmptyString(readAlias(operation, ["supersedesDecisionId", "supersedes_decision_id"]))
    });
    if (!adapted.decision || (adapted.rationale as unknown[]).length === 0 || (adapted.affectedPaths as unknown[]).length === 0) {
      warnings.push(`operation ${index + 1} decision was incomplete and was ignored`);
      return null;
    }
    return adapted;
  }

  const adapted = compact({
    kind,
    type: normalizeAllowedEnum(readAlias(operation, ["type", "validationType", "validation_type"]), ["RESEARCH", "DATA", "STAKEHOLDER", "TECHNICAL"]),
    question: firstNonEmptyString(readAlias(operation, ["question"])),
    reason: firstNonEmptyString(readAlias(operation, ["reason", "impact"])),
    blocking: toBoolean(readAlias(operation, ["blocking", "isBlocking", "is_blocking"])),
    relatedOpenQuestionId: firstNonEmptyString(readAlias(operation, ["relatedOpenQuestionId", "related_open_question_id"])),
    expectedOutput: firstNonEmptyString(readAlias(operation, ["expectedOutput", "expected_output"]))
  });
  if (!adapted.type || !adapted.question || !adapted.reason || adapted.blocking === undefined) {
    warnings.push(`operation ${index + 1} validation request was incomplete and was ignored`);
    return null;
  }
  return adapted;
}

function adaptPathOperation(
  raw: unknown,
  operationIndex: number,
  changeIndex: number,
  warnings: string[]
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`operation ${operationIndex + 1} change ${changeIndex + 1} was ignored because it was not an object`);
    return null;
  }
  const change = raw as Record<string, unknown>;
  const path = firstNonEmptyString(readAlias(change, ["path", "field", "target", "jsonPointer", "json_pointer"]));
  if (!path) {
    warnings.push(`operation ${operationIndex + 1} change ${changeIndex + 1} had no path and was ignored`);
    return null;
  }
  const op = normalizePatchOperation(readAlias(change, ["op", "operation", "action"]));
  return compact({
    op,
    path,
    value: readAlias(change, ["value", "data", "content"]),
    reason: firstNonEmptyString(readAlias(change, ["reason", "summary"]))
  }, true);
}

function adaptReadyEvaluation(
  raw: unknown,
  project: ProjectRecord,
  stage: ReasoningStage,
  warnings: string[]
): Record<string, unknown> {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const criteriaSource = readAlias(source, ["criteria", "items", "checks"]);
  const candidates = Array.isArray(criteriaSource)
    ? criteriaSource
    : criteriaSource && typeof criteriaSource === "object"
      ? Object.entries(criteriaSource as Record<string, unknown>).map(([criterionId, value]) =>
        typeof value === "string" ? { criterionId, status: value } : { criterionId, ...asLooseRecord(value) })
      : [];
  const known = new Map<string, Record<string, unknown>>();
  for (const candidate of candidates) {
    const record = asLooseRecord(candidate);
    const criterionId = firstNonEmptyString(readAlias(record, ["criterionId", "criterion_id", "id", "criterion"]));
    if (!criterionId || !stageRegistry[stage].exitCriteriaIds.includes(criterionId) || known.has(criterionId)) continue;
    known.set(criterionId, {
      criterionId,
      status: normalizeCriterionStatus(readAlias(record, ["status", "result", "state"])),
      reason: firstNonEmptyString(readAlias(record, ["reason", "explanation", "detail"])) ?? "No explanation was returned by the model."
    });
  }
  const criteria = stageRegistry[stage].exitCriteriaIds.map(criterionId => {
    const item = known.get(criterionId);
    if (item) return item;
    warnings.push(`Ready criterion ${criterionId} was missing and was safely marked MISSING`);
    return { criterionId, status: "MISSING", reason: "The model omitted this criterion, so the stage remains in progress." };
  });
  const currentBlockingIds = project.productSpec.openQuestions
    .filter(question => question.ownerStage === stage && question.status === "OPEN" && question.blocking)
    .map(question => question.id);
  const rawBlockingUnknownIds = readAlias(source, ["blockingUnknownIds", "blocking_unknown_ids", "blockers"]);
  const blockingUnknownIds = toStringArray(rawBlockingUnknownIds);
  return {
    criteria,
    blockingUnknownIds: rawBlockingUnknownIds === undefined ? currentBlockingIds : blockingUnknownIds,
    summary: firstNonEmptyString(readAlias(source, ["summary", "reason", "description"])) ?? "The stage remains in progress pending complete evaluation."
  };
}

function parseFlexibleJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const attempts = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      let parsed: unknown = JSON.parse(attempt);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      return parsed;
    } catch {
      // Try the next lossless representation.
    }
  }
  throw new Error("Model response did not contain a parseable JSON stage turn");
}

function normalizeKind(value: unknown): "update_product_spec" | "manage_open_question" | "record_decision" | "request_validation" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s.-]+/g, "_").toLowerCase();
  const aliases: Record<string, ReturnType<typeof normalizeKind>> = {
    update_product_spec: "update_product_spec",
    update_spec: "update_product_spec",
    product_spec_update: "update_product_spec",
    manage_open_question: "manage_open_question",
    manage_question: "manage_open_question",
    open_question: "manage_open_question",
    record_decision: "record_decision",
    decision: "record_decision",
    request_validation: "request_validation",
    validation_request: "request_validation"
  };
  return aliases[normalized];
}

function normalizePatchOperation(value: unknown): "ADD" | "REPLACE" | "REMOVE" {
  const normalized = normalizeEnum(value);
  if (["ADD", "APPEND", "INSERT", "CREATE"].includes(normalized ?? "")) return "ADD";
  if (["REMOVE", "DELETE", "UNSET"].includes(normalized ?? "")) return "REMOVE";
  return "REPLACE";
}

function normalizeQuestionAction(value: unknown): "CREATE" | "RESOLVE" | "DEFER" | "REOPEN" | undefined {
  const normalized = normalizeEnum(value);
  if (["CREATE", "ADD", "OPEN"].includes(normalized ?? "")) return "CREATE";
  if (["RESOLVE", "CLOSE", "ANSWER"].includes(normalized ?? "")) return "RESOLVE";
  if (["DEFER", "POSTPONE"].includes(normalized ?? "")) return "DEFER";
  if (["REOPEN", "RE_OPEN"].includes(normalized ?? "")) return "REOPEN";
  return undefined;
}

function normalizeResolutionMethod(value: unknown): string | undefined {
  const normalized = normalizeEnum(value);
  const aliases: Record<string, string> = {
    USER: "STAKEHOLDER_CONFIRMATION",
    USER_CONFIRMATION: "STAKEHOLDER_CONFIRMATION",
    STAKEHOLDER: "STAKEHOLDER_CONFIRMATION",
    DATA: "DATA_VALIDATION",
    TECHNICAL: "TECHNICAL_VALIDATION",
    PRODUCT: "PRODUCT_DECISION",
    DECISION: "PRODUCT_DECISION"
  };
  const adapted = normalized ? aliases[normalized] ?? normalized : undefined;
  return normalizeAllowedEnum(adapted, [
    "DERIVE", "DEFAULT", "RESEARCH", "DATA_VALIDATION", "STAKEHOLDER_CONFIRMATION",
    "TECHNICAL_VALIDATION", "PRODUCT_DECISION", "DEFER"
  ]);
}

function normalizeCriterionStatus(value: unknown): "SUFFICIENT" | "PARTIAL" | "MISSING" | "NOT_APPLICABLE" {
  const normalized = normalizeEnum(value)?.replace(/\s+/g, "_");
  if (["SUFFICIENT", "READY", "COMPLETE", "PASSED", "PASS"].includes(normalized ?? "")) return "SUFFICIENT";
  if (["PARTIAL", "INCOMPLETE", "PARTIALLY_SUFFICIENT"].includes(normalized ?? "")) return "PARTIAL";
  if (["NOT_APPLICABLE", "N/A", "NA"].includes(normalized ?? "")) return "NOT_APPLICABLE";
  return "MISSING";
}

function normalizeAffectedPath(path: string, stage: ReasoningStage): string {
  const normalized = path.replace(/^\//, "").replaceAll("/", ".");
  const roots = ["discovery", "solution", "interaction"];
  return roots.some(root => normalized === root || normalized.startsWith(`${root}.`))
    ? normalized
    : `${stageRegistry[stage].ownedRoot}.${normalized}`;
}

function normalizeStage(value: unknown): ReasoningStage | undefined {
  const normalized = normalizeEnum(value);
  return normalized === "DISCOVERY" || normalized === "SOLUTION" || normalized === "INTERACTION" ? normalized : undefined;
}

function normalizeEnum(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().replace(/[\s-]+/g, "_").toUpperCase() : undefined;
}

function normalizeAllowedEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const normalized = normalizeEnum(value);
  return normalized && allowed.includes(normalized as T) ? normalized as T : undefined;
}

function readAlias(record: Record<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) if (Object.hasOwn(record, alias)) return record[alias];
  return undefined;
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map(item => item.trim());
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function toInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === "string") {
    if (["true", "yes", "1"].includes(value.trim().toLowerCase())) return true;
    if (["false", "no", "0"].includes(value.trim().toLowerCase())) return false;
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function compact(record: Record<string, unknown>, preserveUndefinedValue = false): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key, value]) => value !== undefined || (preserveUndefinedValue && key === "value")));
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function asLooseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
