import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { ProjectRecord, ReasoningStage } from "../domain/types.js";
import type { StageContextProjection } from "../runtime/context-builder.js";
import { modelTools } from "../tools/definitions.js";
import { stageRegistry } from "../workflow/stage-registry.js";

export interface LatencyStep {
  stepName: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  detail?: Record<string, unknown>;
}

export interface ContextSizeMetric {
  characters: number;
  estimatedTokens: number;
}

export interface ContextSnapshot {
  callIndex: number;
  components: {
    systemPrompt: ContextSizeMetric;
    discoveryInstructions: ContextSizeMetric;
    conversationHistory: ContextSizeMetric;
    discoveryState: ContextSizeMetric;
    productSpecTotal: ContextSizeMetric;
    decisions: ContextSizeMetric;
    questions: ContextSizeMetric;
    workflow: ContextSizeMetric;
    schema: ContextSizeMetric;
    currentTurnInput: ContextSizeMetric;
    otherInstructions: ContextSizeMetric;
    totalRequestPayload: ContextSizeMetric;
  };
  note: string;
}

export interface LlmCallMetric {
  callIndex: number;
  purpose: string;
  model: string;
  reasoningEffort: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  startTime: string;
  firstTokenTime: string | null;
  endTime: string;
  ttftMs: number | null;
  totalDurationMs: number;
  retryCount: number;
  toolCallCount: number;
  finishReason: string | null;
  error?: string;
}

export interface RetryMetric {
  retryReason: string;
  retryIndex: number;
  previousError: string;
  time: string;
}

export interface LatencyRequestTrace {
  requestId: string;
  requestStart: string;
  requestEnd?: string;
  totalDurationMs?: number;
  responseBytes?: number;
  steps: LatencyStep[];
  llmCalls: LlmCallMetric[];
  retries: RetryMetric[];
  contextSnapshots: ContextSnapshot[];
}

const storage = new AsyncLocalStorage<LatencyRequestTrace>();

export function latencyInstrumentationEnabled(): boolean {
  return process.env.LATENCY_INSTRUMENTATION === "1";
}

export async function withLatencyRequest<T>(requestId: string, action: () => Promise<T>): Promise<T> {
  if (!latencyInstrumentationEnabled()) return action();
  const trace: LatencyRequestTrace = {
    requestId,
    requestStart: new Date().toISOString(),
    steps: [],
    llmCalls: [],
    retries: [],
    contextSnapshots: []
  };
  const startedAt = performance.now();
  return storage.run(trace, async () => {
    try {
      return await action();
    } finally {
      trace.requestEnd = new Date().toISOString();
      trace.totalDurationMs = round(performance.now() - startedAt);
      emitTrace(trace);
    }
  });
}

export async function measureLatencyStep<T>(stepName: string, action: () => Promise<T>, detail?: Record<string, unknown>): Promise<T> {
  const trace = storage.getStore();
  if (!trace) return action();
  const startTime = new Date().toISOString();
  const startedAt = performance.now();
  try {
    return await action();
  } finally {
    trace.steps.push({ stepName, startTime, endTime: new Date().toISOString(), durationMs: round(performance.now() - startedAt), detail });
  }
}

export function measureLatencyStepSync<T>(stepName: string, action: () => T, detail?: Record<string, unknown>): T {
  const trace = storage.getStore();
  if (!trace) return action();
  const startTime = new Date().toISOString();
  const startedAt = performance.now();
  try {
    return action();
  } finally {
    trace.steps.push({ stepName, startTime, endTime: new Date().toISOString(), durationMs: round(performance.now() - startedAt), detail });
  }
}

export function recordLlmCall(metric: LlmCallMetric): void {
  storage.getStore()?.llmCalls.push(metric);
}

export function recordRetry(metric: Omit<RetryMetric, "time">): void {
  storage.getStore()?.retries.push({ ...metric, time: new Date().toISOString() });
}

export function recordResponseBytes(bytes: number): void {
  const trace = storage.getStore();
  if (trace) trace.responseBytes = bytes;
}

export function recordContextSnapshot(
  project: ProjectRecord,
  stage: ReasoningStage,
  callIndex: number,
  instructions: string,
  input: unknown[],
  toolNames: string[],
  projection?: StageContextProjection
): void {
  const trace = storage.getStore();
  if (!trace) return;
  const config = stageRegistry[stage];
  const recentMessages = projection?.recentConversation ?? project.messages
    .filter(message => (message.stage ?? "DISCOVERY") === stage)
    .slice(stage === "DISCOVERY" ? -2 : -12)
    .map(({ role, content }) => ({ role, content }));
  const selectedTools = modelTools.filter(tool => toolNames.includes(tool.name));
  const productSpec = projection?.productSpec ?? Object.fromEntries(config.contextRoots.map(root => [root, project.productSpec[root]]));
  const structuredPiecesLength = JSON.stringify({ productSpec, recentConversation: recentMessages }).length;
  const knownInstructionLength = config.prompt.length + structuredPiecesLength;
  const otherInstructions = instructions.slice(0, Math.max(0, instructions.length - knownInstructionLength));
  const components = {
    systemPrompt: sizeMetric(""),
    discoveryInstructions: sizeMetric(config.prompt),
    conversationHistory: sizeMetric(JSON.stringify(recentMessages)),
    discoveryState: sizeMetric(JSON.stringify(project.productSpec.discovery)),
    productSpecTotal: sizeMetric(JSON.stringify(productSpec)),
    decisions: sizeMetric(JSON.stringify(productSpec.decisions ?? [])),
    questions: sizeMetric(JSON.stringify(productSpec.openQuestions ?? [])),
    workflow: sizeMetric(JSON.stringify({ activeStage: project.workflow.activeStage, currentStage: project.workflow.stages[stage] })),
    schema: sizeMetric(JSON.stringify(selectedTools)),
    currentTurnInput: sizeMetric(JSON.stringify(input)),
    otherInstructions: sizeMetric(otherInstructions),
    totalRequestPayload: sizeMetric(`${instructions}\n${JSON.stringify(input)}\n${JSON.stringify(selectedTools)}`)
  };
  trace.contextSnapshots.push({
    callIndex,
    components,
    note: "Component token counts are deterministic local estimates. productSpecTotal overlaps discoveryState, decisions, and questions; provider inputTokens is the authoritative request total."
  });
}

function sizeMetric(value: string): ContextSizeMetric {
  return { characters: value.length, estimatedTokens: estimateTokens(value) };
}

function estimateTokens(value: string): number {
  const cjk = value.match(/[\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const remaining = value.length - cjk;
  return Math.max(0, cjk + Math.ceil(remaining / 4));
}

function emitTrace(trace: LatencyRequestTrace): void {
  const summary = `Request ${trace.requestId} — ${trace.totalDurationMs?.toLocaleString("en-US")}ms`;
  console.log(`[latency] ${summary}`);
  for (const step of trace.steps) console.log(`[latency] ${step.stepName} ${step.durationMs.toLocaleString("en-US")}ms`);
  for (const call of trace.llmCalls) console.log(`[latency] LLM #${call.callIndex} ${call.totalDurationMs.toLocaleString("en-US")}ms tools=${call.toolCallCount} input=${call.inputTokens ?? "n/a"} output=${call.outputTokens ?? "n/a"}`);
  const target = process.env.LATENCY_AUDIT_FILE;
  if (target) appendFileSync(target, `${JSON.stringify(trace)}\n`, "utf8");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
