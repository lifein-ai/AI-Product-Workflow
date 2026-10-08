import { performance } from "node:perf_hooks";
import type { AIProvider, AIProviderProgress, ModelResponse } from "../ai/provider.js";
import type { Decision, ProjectRecord, ReasoningStage } from "../domain/types.js";
import type { RequestPhase } from "./request-progress.js";
import {
  measureLatencyStep,
  measureLatencyStepSync,
  recordContextSnapshot,
  recordLlmCall,
  recordRetry
} from "../observability/latency-trace.js";
import { executeStageTurn } from "../tools/executor.js";
import { parseAndAdaptStageTurn } from "../tools/turn-adapter.js";
import { stageRegistry } from "../workflow/stage-registry.js";
import { reconcileDiscoveryDecisionProjection } from "../workflow/discovery-consistency.js";
import { buildStageContext } from "./context-builder.js";

const MAX_LLM_CALLS_PER_TURN = 2;

export interface ToolLoopProgress {
  onPhase?: (phase: RequestPhase, detail: string) => void;
  onProviderProgress?: (event: AIProviderProgress) => void;
}

export async function runToolLoop(
  project: ProjectRecord,
  userMessage: string,
  ai: AIProvider,
  requestId?: string,
  decisionSource?: NonNullable<Decision["source"]>,
  progress?: ToolLoopProgress
): Promise<string> {
  const stage = project.workflow.activeStage;
  if (!stage || stage === "INTERACTION") throw new Error("Only Discovery and Solution are active V0 runtime stages");
  if (!["IN_PROGRESS", "READY_FOR_CONFIRMATION"].includes(project.workflow.stages[stage].status)) {
    throw new Error(`Cannot run ${stage} while ${project.workflow.stages[stage].status}`);
  }

  const preflightRepair = reconcileDiscoveryDecisionProjection(project);
  const preflightWarnings = preflightRepair.warning ? [preflightRepair.warning] : [];
  const input: unknown[] = [{ role: "user", content: userMessage }];
  const baseRevision = project.productSpec.version.revision;
  const toolNames = stageRegistry[stage].modelTools;
  const expectedTurnTool = toolNames[0];
  const omitInitialRequirement = stage === "DISCOVERY"
    && !project.messages.some(message => (message.stage ?? "DISCOVERY") === "DISCOVERY")
    && userMessage === project.productSpec.project.initialRequirement;
  let purpose = `${stage.toLowerCase()}_turn`;

  for (let callIndex = 1; callIndex <= MAX_LLM_CALLS_PER_TURN; callIndex++) {
    if (callIndex > 1) {
      progress?.onPhase?.("REPAIRING_RESPONSE", "The provider returned output, but it failed local workflow validation. Requesting one bounded repair.");
    }
    const context = measureLatencyStepSync("build_context", () => buildStageContext(project, stage, {
      input,
      toolNames,
      omitInitialRequirement,
      completionInstructions: providerCompletionInstructions(stage, expectedTurnTool)
    }), { callIndex });
    const instructions = context.instructions;
    recordContextSnapshot(project, stage, callIndex, instructions, input, toolNames, context.projection);
    const response = await callModel(ai, { instructions, input, toolNames }, {
      callIndex,
      purpose,
      requestId,
      project,
      progress
    });

    try {
      const selected = measureLatencyStepSync(
        "turn_contract_validation",
        () => selectTurnPayload(response, expectedTurnTool),
        { callIndex }
      );
      const adapted = measureLatencyStepSync(
        "turn_arguments_parse_and_adapt",
        () => parseAndAdaptStageTurn(selected.payload, response.text, project, stage, baseRevision),
        { callIndex }
      );
      const result = measureLatencyStepSync(
        "turn_validation_and_execution",
        () => executeStageTurn(project, adapted.args, baseRevision, decisionSource, [...preflightWarnings, ...selected.warnings, ...adapted.warnings]),
        { callIndex, stage }
      );
      progress?.onPhase?.(
        "VALIDATING_RESPONSE",
        result.compatibilityWarnings.length > 0
          ? `The response was accepted with ${result.compatibilityWarnings.length} safe compatibility adjustment(s).`
          : "The provider response passed local workflow validation."
      );
      if (process.env.RUNTIME_TOOL_TRACE === "1") {
        console.error(`[turn] ${expectedTurnTool}: ${JSON.stringify({
          operations: result.operationResults,
          readyEvaluation: result.readyEvaluationResult,
          compatibilityWarnings: result.compatibilityWarnings
        })}`);
      }
      return result.assistantResponse;
    } catch (error) {
      const previousError = error instanceof Error ? error.message : String(error);
      if (callIndex === MAX_LLM_CALLS_PER_TURN) throw new Error(`${stage} turn repair failed: ${previousError}`, { cause: error });
      recordRetry({ retryReason: "turn_contract_or_operation_validation", retryIndex: 1, previousError });
      progress?.onPhase?.("REPAIRING_RESPONSE", "The provider response arrived, but did not match the workflow contract. Preparing one repair call.");
      appendRepairContext(input, response, previousError);
      purpose = `repair_${stage.toLowerCase()}_turn`;
    }
  }

  throw new Error(`${stage} turn did not produce a valid result`);
}

function providerCompletionInstructions(stage: ReasoningStage, toolName: string): string {
  const efficiency = "The structured context is canonical. Never rewrite an unchanged field merely to restate it. Emit only changes required by new user information, consolidate related field changes, and keep the user-facing response concise. Target a complete response under 3,500 output tokens.";
  if (stage !== "DISCOVERY") {
    return `# COMPLETION PROTOCOL\n${efficiency}\nReturn exactly one ${toolName} call. Include the complete assistantResponse, all state operations in execution order, and the Ready evaluation in that call. The server executes the batch atomically and makes the final Ready decision. Do not wait for tool results or claim that the server marked the stage Ready.`;
  }
  return `# COMPLETION PROTOCOL
${efficiency}
Return exactly one ${toolName} call for this turn, containing assistantResponse, all operations in execution order, and a complete readyEvaluation.
- Put Product Spec changes in update_product_spec.
- Put key unknown lifecycle changes in manage_open_question.
- Put explicit product decisions in record_decision. To reference a new Decision in the same turn, give it a reference first and use $decision:<reference> in the later Product Spec value.
- Put external fact requests in request_validation.
The server validates and executes the batch atomically and makes the final Ready decision. Do not wait for tool results or claim that persistence succeeded or the stage became Ready.`;
}

function selectTurnPayload(response: ModelResponse, expectedTurnTool: string): { payload: string; warnings: string[] } {
  const matchingCalls = response.calls.filter(call => call.name.trim() === expectedTurnTool);
  if (matchingCalls.length > 1) throw new Error(`Received multiple ${expectedTurnTool} calls`);
  if (matchingCalls.length === 1) {
    const warnings = response.calls.length > 1
      ? [`Ignored ${response.calls.length - 1} unrelated tool call(s) and used ${expectedTurnTool}`]
      : [];
    return { payload: matchingCalls[0].arguments, warnings };
  }
  if (response.text.trim()) {
    return {
      payload: response.text,
      warnings: [`Recovered ${expectedTurnTool} arguments from response text because no function call was returned`]
    };
  }
  throw new Error(`Expected ${expectedTurnTool}; received ${response.calls.map(call => call.name).join(", ") || "no tool call"}`);
}

async function callModel(
  ai: AIProvider,
  request: { instructions: string; input: unknown[]; toolNames: string[] },
  context: { callIndex: number; purpose: string; requestId?: string; project: ProjectRecord; progress?: ToolLoopProgress }
): Promise<ModelResponse> {
  const { callIndex, purpose, requestId, project, progress } = context;
  const startTime = new Date().toISOString();
  const startedAt = performance.now();
  try {
    if (process.env.DISCOVERY_REQUEST_LOG === "1") {
      const event = callIndex === 1 ? "Initial Request → Provider Call" : "Tool Loop Continuation (Exceptional Repair)";
      console.info(`[discovery-request] ${event}`, {
        request_id: requestId ?? "unavailable",
        project_id: project.id,
        call_index: callIndex,
        purpose
      });
    }
    const response = await measureLatencyStep("llm_call", () => ai.generate({
      ...request,
      ...(requestId ? { idempotencyKey: `${requestId}:tool-call:${callIndex}` } : {}),
      ...(callIndex > 1 ? {
        maxRetries: 0,
        timeoutMs: readRepairTimeout()
      } : {}),
      onProgress: progress?.onProviderProgress
    }), { callIndex, purpose });
    const telemetry = response.observability;
    recordLlmCall({
      callIndex,
      purpose,
      model: telemetry?.model ?? process.env.MODELFLARE_MODEL ?? "unknown",
      reasoningEffort: telemetry?.reasoningEffort ?? "unspecified",
      inputTokens: telemetry?.inputTokens ?? null,
      outputTokens: telemetry?.outputTokens ?? null,
      cachedInputTokens: telemetry?.cachedInputTokens ?? null,
      reasoningTokens: telemetry?.reasoningTokens ?? null,
      startTime,
      firstTokenTime: telemetry?.firstTokenTime ?? null,
      endTime: new Date().toISOString(),
      ttftMs: telemetry?.ttftMs ?? null,
      totalDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      retryCount: telemetry?.retryCount ?? 0,
      toolCallCount: response.calls.length,
      finishReason: telemetry?.finishReason ?? null
    });
    return response;
  } catch (error) {
    recordLlmCall({
      callIndex,
      purpose,
      model: process.env.MODELFLARE_MODEL ?? "unknown",
      reasoningEffort: "unspecified",
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
      startTime,
      firstTokenTime: null,
      endTime: new Date().toISOString(),
      ttftMs: null,
      totalDurationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      retryCount: 0,
      toolCallCount: 0,
      finishReason: "error",
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function readRepairTimeout(): number {
  const parsed = Number(process.env.MODELFLARE_REPAIR_TIMEOUT_MS ?? 180_000);
  return Number.isInteger(parsed) && parsed >= 10_000 && parsed <= 300_000 ? parsed : 180_000;
}

function appendRepairContext(input: unknown[], response: ModelResponse, previousError: string): void {
  input.push(...response.historyItems);
  if (response.calls.length > 0) {
    for (const call of response.calls) {
      input.push({
        type: "function_call_output",
        call_id: call.callId,
        output: JSON.stringify({ success: false, error: previousError })
      });
    }
  } else {
    input.push({
      role: "user",
      content: `Your response failed the required turn contract: ${previousError}. Return one corrected stage turn call.`
    });
  }
}
