import { randomUUID } from "node:crypto";
import type { AIProvider } from "../ai/provider.js";
import type { ConversationMessage, Decision, DecisionAlternative, ProjectRecord, ReasoningStage } from "../domain/types.js";
import { runGenerationCallWithRepair } from "../generation/generation-call.js";
import { DECISION_EXTRACTION_PROMPT } from "../prompts/decision-extraction.js";
import type { ProjectRepository } from "../repositories/project-repository.js";
import {
  DECISION_EXTRACTION_TOOL_NAME,
  type DecisionCandidate,
  decisionExtractionSchema
} from "./schemas.js";

export const DEFAULT_DECISION_SCAN_MESSAGE_THRESHOLD = 6;
export const MAX_DECISION_SCAN_MESSAGES = 12;
export const DECISION_SCAN_OVERLAP_MESSAGES = 4;
const MAX_RELEVANT_DECISIONS = 12;

export interface DecisionScanResult {
  status: "SKIPPED" | "SCANNED" | "FAILED";
  scannedMessageCount: number;
  created: number;
  updated: number;
  superseded: number;
  ignored: number;
  remainingMessageCount: number;
  error?: string;
}

export class DecisionMemoryService {
  constructor(
    private readonly repo: ProjectRepository,
    private readonly ai: AIProvider,
    private readonly automaticMessageThreshold = DEFAULT_DECISION_SCAN_MESSAGE_THRESHOLD
  ) {}

  scanIfNeeded(projectId: string) {
    return this.scan(projectId, false);
  }

  scanNow(projectId: string) {
    return this.scan(projectId, true);
  }

  private async scan(projectId: string, force: boolean): Promise<DecisionScanResult> {
    let project: ProjectRecord | null;
    try {
      project = await this.repo.getById(projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...emptyResult("FAILED", 0, 0), error: message };
    }
    if (!project) throw new Error("Project not found");
    let pendingMessageCount = 0;
    try {
      const startIndex = checkpointIndex(project);
      const pending = project.messages.slice(startIndex);
      pendingMessageCount = pending.length;
      if (pending.length === 0 || (!force && pending.length < this.automaticMessageThreshold)) {
        return emptyResult("SKIPPED", 0, pending.length);
      }

      const scanMessages = pending.slice(0, MAX_DECISION_SCAN_MESSAGES);
      const contextStart = Math.max(0, startIndex - DECISION_SCAN_OVERLAP_MESSAGES);
      const conversation = project.messages.slice(contextStart, startIndex + scanMessages.length);
      const remainingMessageCount = pending.length - scanMessages.length;
      const extraction = await runGenerationCallWithRepair({
        ai: this.ai,
        instructions: DECISION_EXTRACTION_PROMPT,
        input: [{
          role: "user",
          content: JSON.stringify({
            project: { id: project.id, name: project.productSpec.project.name },
            existingDecisions: relevantDecisionContexts(project, conversation),
            conversation
          })
        }],
        toolName: DECISION_EXTRACTION_TOOL_NAME,
        parse: value => decisionExtractionSchema.parse(value),
        maxRetries: 2
      });

      const counts = mergeDecisionCandidates(project, extraction.decisions, conversation);
      const timestamp = new Date().toISOString();
      project.decisionMemory = {
        status: remainingMessageCount > 0 ? "PENDING" : "IDLE",
        pendingMessageCount: remainingMessageCount,
        lastAttemptAt: timestamp,
        lastScannedAt: timestamp,
        lastScannedMessageId: scanMessages.at(-1)?.id
      };
      await this.repo.save(project);
      return { status: "SCANNED", scannedMessageCount: scanMessages.length, remainingMessageCount, ...counts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailure(projectId, message, pendingMessageCount);
      return { ...emptyResult("FAILED", 0, pendingMessageCount), error: message };
    }
  }

  private async recordFailure(projectId: string, error: string, pendingMessageCount: number) {
    try {
      const latest = await this.repo.getById(projectId);
      if (!latest) return;
      latest.decisionMemory = {
        ...latest.decisionMemory,
        status: "FAILED",
        pendingMessageCount,
        lastAttemptAt: new Date().toISOString(),
        lastError: error
      };
      await this.repo.save(latest);
    } catch {
      // Decision Memory is auxiliary; even failure observability must not break the main workflow.
    }
  }
}

function relevantDecisionContexts(project: ProjectRecord, conversation: ConversationMessage[]) {
  const conversationText = normalize(conversation.map(message => message.content).join(" "));
  const stages = new Set(conversation.map(message => message.stage).filter(Boolean));
  const sorted = [...project.productSpec.decisions].sort((left, right) =>
    (right.updatedAt ?? right.createdAt ?? "").localeCompare(left.updatedAt ?? left.createdAt ?? "")
  );
  const matched = sorted.filter(decision => [decision.feature, decision.topic, decision.decision]
    .filter((value): value is string => Boolean(value))
    .some(value => {
      const key = normalize(value);
      return key.length >= 2 && conversationText.includes(key);
    }));
  const recentActive = sorted.filter(decision => decision.status === "ACTIVE" && stages.has(decision.stage)).slice(0, 8);
  return [...new Map([...matched, ...recentActive].map(decision => [decision.id, decision])).values()]
    .slice(0, MAX_RELEVANT_DECISIONS)
    .map(decisionContext);
}

export function mergeDecisionCandidates(
  project: ProjectRecord,
  candidates: DecisionCandidate[],
  conversation: ConversationMessage[]
) {
  const counts = { created: 0, updated: 0, superseded: 0, ignored: 0 };
  const allowedMessageIds = new Set(conversation.map(message => message.id));
  for (const candidate of candidates) {
    if (candidate.action === "IGNORE") {
      counts.ignored += 1;
      continue;
    }
    const sourceMessageIds = candidate.sourceMessageIds.filter(id => allowedMessageIds.has(id));
    if (sourceMessageIds.length !== candidate.sourceMessageIds.length) {
      throw new Error("Decision extraction referenced a message outside the supplied conversation batch");
    }
    const topicKey = normalize(candidate.topic);
    const requestedTarget = project.productSpec.decisions.find(item => item.id === candidate.targetDecisionId);
    const target = (requestedTarget?.status !== "SUPERSEDED" ? requestedTarget : undefined)
      ?? project.productSpec.decisions.find(item => item.status === "ACTIVE" && normalize(item.topic ?? item.decision) === topicKey)
      ?? project.productSpec.decisions.find(item => item.status === "DEFERRED" && normalize(item.topic ?? item.decision) === topicKey);

    if (target && normalize(target.decision) === normalize(candidate.decision)) {
      if (enrichDecision(target, candidate, sourceMessageIds)) counts.updated += 1;
      else counts.ignored += 1;
      continue;
    }

    const tentative = candidate.strength === "TENTATIVE";
    if (target && !tentative) {
      const timestamp = new Date().toISOString();
      target.status = "SUPERSEDED";
      target.updatedAt = timestamp;
      target.history ??= [];
      target.history.push(historyEntry("SUPERSEDED", target, sourceMessageIds, timestamp));
      const replacement = createDecision(project, candidate, sourceMessageIds, conversation, target.id);
      target.supersededBy = replacement.id;
      project.productSpec.decisions.push(replacement);
      counts.superseded += 1;
      continue;
    }

    const duplicate = project.productSpec.decisions.find(item =>
      item.status !== "SUPERSEDED"
      && normalize(item.topic ?? item.decision) === topicKey
      && normalize(item.decision) === normalize(candidate.decision)
    );
    if (duplicate) {
      if (enrichDecision(duplicate, candidate, sourceMessageIds)) counts.updated += 1;
      else counts.ignored += 1;
      continue;
    }

    project.productSpec.decisions.push(createDecision(project, candidate, sourceMessageIds, conversation));
    counts.created += 1;
  }
  return counts;
}

function createDecision(
  project: ProjectRecord,
  candidate: DecisionCandidate,
  sourceMessageIds: string[],
  conversation: ConversationMessage[],
  supersedesDecisionId?: string
): Decision {
  const timestamp = new Date().toISOString();
  const status = candidate.strength === "TENTATIVE" ? "DEFERRED" : candidate.status;
  const stage = sourceStage(sourceMessageIds, conversation, project.workflow.activeStage);
  const decision: Decision = {
    id: randomUUID(),
    projectId: project.id,
    stage,
    feature: candidate.feature,
    topic: candidate.topic,
    decision: candidate.decision,
    rationale: candidate.reason ? [candidate.reason] : [],
    reason: candidate.reason,
    alternatives: candidate.alternatives,
    importance: candidate.importance,
    strength: candidate.strength,
    status,
    affectedPaths: [],
    source: { type: "DECISION_EXTRACTION" },
    sourceMessageIds,
    createdAt: timestamp,
    updatedAt: timestamp,
    history: [],
    ...(supersedesDecisionId ? { supersedesDecisionId } : {})
  };
  decision.history!.push(historyEntry("CREATED", decision, sourceMessageIds, timestamp));
  return decision;
}

function enrichDecision(target: Decision, candidate: DecisionCandidate, sourceMessageIds: string[]): boolean {
  const alternatives = mergeAlternatives(target.alternatives ?? [], candidate.alternatives);
  const sources = [...new Set([...(target.sourceMessageIds ?? []), ...sourceMessageIds])];
  const nextReason = candidate.reason ?? target.reason ?? (target.rationale?.join(" · ") || null);
  const nextTopic = !target.topic || target.topic === target.decision ? candidate.topic : target.topic;
  const nextFeature = !target.feature || target.feature === target.stage ? candidate.feature : target.feature;
  const nextImportance = Math.max(target.importance ?? 1, candidate.importance) as 1 | 2 | 3;
  const nextStrength = stronger(target.strength, candidate.strength);
  const changed = JSON.stringify({
    alternatives: target.alternatives ?? [], reason: target.reason ?? null,
    topic: target.topic, feature: target.feature, importance: target.importance, strength: target.strength
  }) !== JSON.stringify({
    alternatives, reason: nextReason, topic: nextTopic, feature: nextFeature,
    importance: nextImportance, strength: nextStrength
  });
  if (!changed) return false;

  const timestamp = new Date().toISOString();
  target.history ??= [];
  target.history.push(historyEntry("UPDATED", target, sourceMessageIds, timestamp));
  target.alternatives = alternatives;
  target.sourceMessageIds = sources;
  target.reason = nextReason;
  target.rationale = nextReason ? [nextReason] : [];
  target.topic = nextTopic;
  target.feature = nextFeature;
  target.importance = nextImportance;
  target.strength = nextStrength;
  target.updatedAt = timestamp;
  return true;
}

function mergeAlternatives(current: DecisionAlternative[], incoming: DecisionAlternative[]): DecisionAlternative[] {
  const merged = current.map(item => ({ ...item }));
  for (const alternative of incoming) {
    const existing = merged.find(item => normalize(item.option) === normalize(alternative.option));
    if (!existing) merged.push(alternative);
    else if (!existing.rejectionReason && alternative.rejectionReason) existing.rejectionReason = alternative.rejectionReason;
  }
  return merged;
}

function stronger(current: Decision["strength"], incoming: DecisionCandidate["strength"]): DecisionCandidate["strength"] {
  const rank = { TENTATIVE: 0, IMPLIED: 1, EXPLICIT: 2 };
  return !current || rank[incoming] > rank[current] ? incoming : current;
}

function historyEntry(
  action: "CREATED" | "UPDATED" | "SUPERSEDED",
  decision: Decision,
  sourceMessageIds: string[],
  at: string
) {
  return { action, at, decision: decision.decision, reason: decision.reason ?? (decision.rationale?.join(" · ") || null), sourceMessageIds };
}

function sourceStage(
  sourceMessageIds: string[],
  conversation: ConversationMessage[],
  fallback: ReasoningStage | null
): ReasoningStage {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (sourceMessageIds.includes(conversation[index].id) && conversation[index].stage) return conversation[index].stage!;
  }
  return fallback ?? "DISCOVERY";
}

function checkpointIndex(project: ProjectRecord): number {
  const checkpoint = project.decisionMemory?.lastScannedMessageId;
  if (!checkpoint) return 0;
  const index = project.messages.findIndex(message => message.id === checkpoint);
  return index < 0 ? 0 : index + 1;
}

function decisionContext(decision: Decision) {
  return {
    id: decision.id,
    feature: decision.feature ?? decision.stage,
    topic: decision.topic ?? decision.decision,
    decision: decision.decision,
    reason: decision.reason ?? (decision.rationale?.join(" · ") || null),
    alternatives: decision.alternatives ?? [],
    importance: decision.importance ?? 2,
    strength: decision.strength ?? "EXPLICIT",
    status: decision.status,
    supersedesDecisionId: decision.supersedesDecisionId,
    supersededBy: decision.supersededBy
  };
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function emptyResult(
  status: DecisionScanResult["status"],
  scannedMessageCount: number,
  remainingMessageCount: number
): DecisionScanResult {
  return { status, scannedMessageCount, remainingMessageCount, created: 0, updated: 0, superseded: 0, ignored: 0 };
}
