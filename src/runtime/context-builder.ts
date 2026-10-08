import type { ProjectRecord, ReasoningStage } from "../domain/types.js";
import { modelTools } from "../tools/definitions.js";
import { stageRegistry } from "../workflow/stage-registry.js";

export const DISCOVERY_CONTEXT_INPUT_BUDGET_TOKENS = 8_000;

export type ConversationProjectionMode = "LOCAL_TURN" | "ASSISTANT_ONLY" | "NONE" | "STAGE_WINDOW";

export interface StageContextProjection {
  productSpec: Record<string, unknown>;
  productSpecRevision: number;
  workflow: {
    activeStage: ProjectRecord["workflow"]["activeStage"];
    currentStage: ProjectRecord["workflow"]["stages"][ReasoningStage];
  };
  recentConversation: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface StageContextBuildResult {
  instructions: string;
  projection: StageContextProjection;
  estimatedInputTokens: number;
  inputTokenBudget: number | null;
  conversationMode: ConversationProjectionMode;
}

interface ContextBuildOptions {
  input?: unknown[];
  toolNames?: string[];
  inputTokenBudget?: number;
  completionInstructions?: string;
  omitInitialRequirement?: boolean;
}

export function buildStageContext(
  project: ProjectRecord,
  stage: ReasoningStage,
  options: ContextBuildOptions = {}
): StageContextBuildResult {
  const config = stageRegistry[stage];
  const input = options.input ?? [];
  const toolNames = options.toolNames ?? config.modelTools;
  const selectedTools = modelTools.filter(tool => toolNames.includes(tool.name));
  const productSpec = projectStageProductSpec(project, stage, options.omitInitialRequirement);
  const historyCandidates = conversationCandidates(project, stage);
  const inputTokenBudget = stage === "DISCOVERY"
    ? options.inputTokenBudget ?? DISCOVERY_CONTEXT_INPUT_BUDGET_TOKENS
    : null;

  for (const candidate of historyCandidates) {
    const projection: StageContextProjection = {
      productSpec,
      productSpecRevision: project.productSpec.version.revision,
      workflow: {
        activeStage: project.workflow.activeStage,
        currentStage: project.workflow.stages[stage]
      },
      recentConversation: candidate.messages
    };
    const instructions = renderInstructions(stage, projection, options.completionInstructions);
    const estimatedInputTokens = estimateRequestInputTokens(instructions, input, selectedTools);
    if (inputTokenBudget === null || estimatedInputTokens <= inputTokenBudget) {
      return {
        instructions,
        projection,
        estimatedInputTokens,
        inputTokenBudget,
        conversationMode: candidate.mode
      };
    }
  }

  const withoutHistory = historyCandidates.at(-1)!;
  const projection: StageContextProjection = {
    productSpec,
    productSpecRevision: project.productSpec.version.revision,
    workflow: {
      activeStage: project.workflow.activeStage,
      currentStage: project.workflow.stages[stage]
    },
    recentConversation: withoutHistory.messages
  };
  const instructions = renderInstructions(stage, projection, options.completionInstructions);
  const estimatedInputTokens = estimateRequestInputTokens(instructions, input, selectedTools);
  throw new Error(
    `Discovery context exceeds estimated input token budget of ${inputTokenBudget} after removing conversation history (estimated ${estimatedInputTokens})`
  );
}

export function buildStageInstructions(
  project: ProjectRecord,
  stage: ReasoningStage,
  options: ContextBuildOptions = {}
): string {
  return buildStageContext(project, stage, options).instructions;
}

export function estimateRequestInputTokens(instructions: string, input: unknown[], selectedTools: unknown[]): number {
  return estimateTokens(`${instructions}\n${JSON.stringify(input)}\n${JSON.stringify(selectedTools)}`);
}

export function estimateTokens(value: string): number {
  const cjk = value.match(/[\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const remaining = value.length - cjk;
  return Math.max(0, cjk + Math.ceil(remaining / 4));
}

function projectStageProductSpec(
  project: ProjectRecord,
  stage: ReasoningStage,
  omitInitialRequirement = false
): Record<string, unknown> {
  const config = stageRegistry[stage];
  const spec = project.productSpec;
  const selected: Record<string, unknown> = {};

  for (const root of config.contextRoots) {
    if (root === "openQuestions") {
      selected[root] = stage === "DISCOVERY"
        ? spec.openQuestions.filter(question => question.ownerStage === "DISCOVERY" && question.status === "OPEN")
        : spec.openQuestions.filter(question =>
            question.status === "OPEN" && (question.ownerStage === stage || (stage === "SOLUTION" && question.ownerStage === "DISCOVERY"))
          );
    } else if (root === "decisions") {
      selected[root] = stage === "DISCOVERY"
        ? spec.decisions.filter(decision => decision.stage === "DISCOVERY" && decision.status === "ACTIVE")
        : spec.decisions.filter(decision =>
            decision.status === "ACTIVE" && (decision.stage === stage || (stage === "SOLUTION" && decision.stage === "DISCOVERY"))
          );
    } else if (root === "project" && omitInitialRequirement) {
      const { initialRequirement: _initialRequirement, ...projectContext } = spec.project;
      selected[root] = projectContext;
    } else {
      selected[root] = spec[root as keyof typeof spec];
    }
  }

  return selected;
}

function conversationCandidates(
  project: ProjectRecord,
  stage: ReasoningStage
): Array<{ mode: ConversationProjectionMode; messages: Array<{ role: "user" | "assistant"; content: string }> }> {
  const stageMessages = project.messages
    .filter(message => (message.stage ?? "DISCOVERY") === stage)
    .map(({ role, content }) => ({ role, content }));

  const localTurn = lastCompleteLocalTurn(stageMessages);
  const lastAssistant = [...localTurn].reverse().find(message => message.role === "assistant");
  return [
    { mode: "LOCAL_TURN", messages: localTurn },
    { mode: "ASSISTANT_ONLY", messages: lastAssistant ? [lastAssistant] : [] },
    { mode: "NONE", messages: [] }
  ];
}

function lastCompleteLocalTurn(
  messages: Array<{ role: "user" | "assistant"; content: string }>
): Array<{ role: "user" | "assistant"; content: string }> {
  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }
  if (lastAssistantIndex < 0) return messages.slice(-1);
  const previous = messages[lastAssistantIndex - 1];
  const startIndex = previous?.role === "user" ? lastAssistantIndex - 1 : lastAssistantIndex;
  return messages.slice(startIndex, lastAssistantIndex + 1);
}

function renderInstructions(stage: ReasoningStage, projection: StageContextProjection, completionInstructions?: string): string {
  const config = stageRegistry[stage];
  const context = `${config.prompt}\n\n# CURRENT STRUCTURED CONTEXT\n${JSON.stringify(
    projection,
    null,
    2
  )}`;
  return completionInstructions?.trim() ? `${context}\n\n${completionInstructions.trim()}` : context;
}
