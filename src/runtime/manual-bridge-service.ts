import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Decision, ProjectRecord, ReasoningStage } from "../domain/types.js";
import type { ProjectRepository } from "../repositories/project-repository.js";
import { completeDiscoveryTurnSchema } from "../tools/schemas.js";
import { modelTools } from "../tools/definitions.js";
import { executeStageTurn } from "../tools/executor.js";
import { startStage } from "../workflow/state-machine.js";
import { stageRegistry } from "../workflow/stage-registry.js";
import { buildStageContext } from "./context-builder.js";
import { SOLUTION_KICKOFF } from "./stage-messages.js";

export const MANUAL_BRIDGE_START = "<<<AI_PRODUCT_WORKFLOW_UPDATE>>>";
export const MANUAL_BRIDGE_END = "<<<END_AI_PRODUCT_WORKFLOW_UPDATE>>>";
export type ManualBridgeTurnKind = "USER_MESSAGE" | "SOLUTION_START";

export interface ManualBridgePromptResult {
  schemaVersion: "manual-bridge-prompt.v1";
  stage: ReasoningStage;
  kind: ManualBridgeTurnKind;
  expectedRevision: number;
  expectedRecordVersion: number;
  turnToken: string;
  userMessage: string;
  prompt: string;
}

export interface ApplyManualBridgeInput {
  stage: ReasoningStage;
  kind: ManualBridgeTurnKind;
  expectedRevision: number;
  expectedRecordVersion: number;
  turnToken: string;
  userMessage: string;
  response: string;
}

export class ManualBridgeResponseError extends Error {}

const manualBridgeTurnSchema = completeDiscoveryTurnSchema
  .omit({ assistantResponse: true })
  .extend({ schemaVersion: z.literal("manual-bridge-turn.v1") })
  .strict();

export class ManualBridgeService {
  private readonly turnTokenKey = randomBytes(32);

  constructor(private readonly repo: ProjectRepository) {}

  async preparePrompt(
    projectId: string,
    input: { kind?: ManualBridgeTurnKind; content?: string }
  ): Promise<ManualBridgePromptResult> {
    const project = await this.requireProject(projectId);
    const kind = input.kind ?? "USER_MESSAGE";
    const snapshot = structuredClone(project);
    const userMessage = kind === "SOLUTION_START" ? SOLUTION_KICKOFF : input.content?.trim();
    if (!userMessage) throw new ManualBridgeResponseError("Manual Bridge user message is required");

    let stage = snapshot.workflow.activeStage;
    if (kind === "SOLUTION_START") {
      startStage(snapshot, "SOLUTION");
      stage = "SOLUTION";
    }
    assertWritableStage(snapshot, stage);

    const expectedRevision = project.productSpec.version.revision;
    const toolName = stageRegistry[stage].modelTools[0];
    const context = buildStageContext(snapshot, stage, {
      input: [{ role: "user", content: userMessage }],
      toolNames: [toolName],
      completionInstructions: "# COMPLETION PROTOCOL\nThe structured context is canonical. Never rewrite unchanged fields merely to restate them. Keep the user-facing response concise and follow the Manual Bridge output protocol below."
    });
    const prompt = renderManualPrompt(context.instructions, userMessage, stage, expectedRevision, toolName);
    const turnToken = manualTurnToken(this.turnTokenKey, project.id, stage, kind, expectedRevision, project.recordVersion, userMessage);

    return {
      schemaVersion: "manual-bridge-prompt.v1",
      stage,
      kind,
      expectedRevision,
      expectedRecordVersion: project.recordVersion,
      turnToken,
      userMessage,
      prompt
    };
  }

  async applyResponse(projectId: string, input: ApplyManualBridgeInput) {
    const expectedToken = manualTurnToken(
      this.turnTokenKey,
      projectId,
      input.stage,
      input.kind,
      input.expectedRevision,
      input.expectedRecordVersion,
      input.userMessage
    );
    if (!validTurnToken(input.turnToken, expectedToken)) {
      throw new ManualBridgeResponseError("Manual Bridge turn metadata does not match the generated prompt");
    }
    const parsed = parseManualBridgeResponse(input.response);
    if (parsed.turn.expectedRevision !== input.expectedRevision) {
      throw new Error(`Stale Product Spec revision: expected ${input.expectedRevision}`);
    }

    const project = await this.requireProject(projectId);
    if (project.productSpec.version.revision !== input.expectedRevision) {
      throw new Error(`Project changed concurrently: expected revision ${input.expectedRevision}, current revision ${project.productSpec.version.revision}`);
    }
    if (project.recordVersion !== input.expectedRecordVersion) {
      throw new Error(`Project changed concurrently: expected record version ${input.expectedRecordVersion}, current record version ${project.recordVersion}`);
    }

    if (input.kind === "SOLUTION_START") {
      if (input.stage !== "SOLUTION") throw new ManualBridgeResponseError("Solution start response must target SOLUTION");
      startStage(project, "SOLUTION");
    } else if (project.workflow.activeStage !== input.stage) {
      throw new Error(`Project changed concurrently: active stage is ${project.workflow.activeStage ?? "none"}`);
    }
    assertWritableStage(project, input.stage);

    const messageId = randomUUID();
    const decisionSource: NonNullable<Decision["source"]> = input.kind === "USER_MESSAGE"
      ? { type: "USER_MESSAGE", messageId }
      : { type: "SYSTEM" };
    let execution: ReturnType<typeof executeStageTurn>;
    try {
      execution = executeStageTurn(project, {
        ...parsed.turn,
        assistantResponse: parsed.assistantResponse
      }, input.expectedRevision, decisionSource, [], false);
    } catch (error) {
      throw new ManualBridgeResponseError(
        `Manual Bridge update failed validation: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
    const timestamp = new Date().toISOString();
    if (input.kind === "USER_MESSAGE") {
      project.messages.push({ id: messageId, role: "user", content: input.userMessage, createdAt: timestamp, stage: input.stage });
    }
    project.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: execution.assistantResponse,
      createdAt: new Date().toISOString(),
      stage: input.stage
    });
    await this.repo.save(project);
    return {
      reply: execution.assistantResponse,
      project,
      compatibilityWarnings: execution.compatibilityWarnings
    };
  }

  private async requireProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.repo.getById(projectId);
    if (!project) throw new Error("Project not found");
    return project;
  }
}

function assertWritableStage(project: ProjectRecord, stage: ReasoningStage | null): asserts stage is ReasoningStage {
  if (!stage || stage === "INTERACTION") throw new Error("Only Discovery and Solution are active V0 runtime stages");
  const status = project.workflow.stages[stage].status;
  if (status !== "IN_PROGRESS" && status !== "READY_FOR_CONFIRMATION") {
    throw new Error(`Cannot run ${stage} while ${status}`);
  }
}

function parseManualBridgeResponse(response: string): {
  assistantResponse: string;
  turn: z.infer<typeof manualBridgeTurnSchema>;
} {
  const startIndex = response.indexOf(MANUAL_BRIDGE_START);
  const endIndex = response.indexOf(MANUAL_BRIDGE_END);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new ManualBridgeResponseError("ChatGPT response is missing the Manual Bridge update block");
  }
  if (response.indexOf(MANUAL_BRIDGE_START, startIndex + MANUAL_BRIDGE_START.length) >= 0
    || response.indexOf(MANUAL_BRIDGE_END, endIndex + MANUAL_BRIDGE_END.length) >= 0) {
    throw new ManualBridgeResponseError("ChatGPT response must contain exactly one Manual Bridge update block");
  }
  if (response.slice(endIndex + MANUAL_BRIDGE_END.length).trim()) {
    throw new ManualBridgeResponseError("ChatGPT response contains content after the Manual Bridge update block");
  }

  const assistantResponse = response.slice(0, startIndex).trim();
  if (!assistantResponse) throw new ManualBridgeResponseError("ChatGPT response must include a user-facing answer before the update block");
  let jsonText = response.slice(startIndex + MANUAL_BRIDGE_START.length, endIndex).trim();
  const fence = jsonText.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) jsonText = fence[1].trim();

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    throw new ManualBridgeResponseError("Manual Bridge update block is not valid JSON", { cause: error });
  }
  try {
    return { assistantResponse, turn: manualBridgeTurnSchema.parse(raw) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const detail = error.issues.map(issue => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
      throw new ManualBridgeResponseError(`Manual Bridge update failed schema validation: ${detail}`, { cause: error });
    }
    throw error;
  }
}

function renderManualPrompt(
  instructions: string,
  userMessage: string,
  stage: ReasoningStage,
  expectedRevision: number,
  toolName: string
): string {
  const tool = modelTools.find(candidate => candidate.name === toolName) as { parameters?: Record<string, unknown> } | undefined;
  if (!tool?.parameters) throw new Error(`Manual Bridge schema not found for ${toolName}`);
  const schema = structuredClone(tool.parameters) as {
    required?: string[];
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  schema.required = ["schemaVersion", ...(schema.required ?? []).filter(name => name !== "assistantResponse")];
  schema.properties = {
    schemaVersion: { type: "string", const: "manual-bridge-turn.v1" },
    ...(schema.properties ?? {})
  };
  delete schema.properties.assistantResponse;
  const criteria = stageRegistry[stage].exitCriteriaIds.map(criterionId => ({
    criterionId,
    status: "MISSING",
    reason: "Replace with the current evidence-based evaluation"
  }));

  return `${instructions}

# CHATGPT MANUAL BRIDGE
You are discussing this product with the user inside ChatGPT. ChatGPT Memory and prior conversations may help with the user's stable preferences, working style, or cross-project experience. They are not authoritative for facts about this project. CURRENT STRUCTURED CONTEXT is the only source of truth for current project facts; when Memory conflicts with it, follow the project context and ask rather than overwrite.
Use the two-part output protocol below while keeping all product reasoning, state ownership, operation, and readiness rules unchanged.

# CURRENT USER MESSAGE
${userMessage}

# MANUAL BRIDGE OUTPUT PROTOCOL
Reply in two consecutive parts:
1. First write the normal, complete, user-facing ${stage === "DISCOVERY" ? "Discovery" : "Product Solution"} response. This is what the Workflow will show in the conversation. Do not mention the bridge protocol in that answer.
2. Then append exactly one machine-readable update block using the exact boundary lines below. Put one JSON object between them. Do not write anything after the end boundary.

The JSON must use expectedRevision ${expectedRevision}, schemaVersion "manual-bridge-turn.v1", all state operations required by this turn in execution order, and one complete Ready evaluation. Do not include assistantResponse in JSON because the natural-language part above is the assistant response. The Workflow will validate and execute this block atomically. Never claim the stage is Ready or confirmed; only the Workflow decides that.

${MANUAL_BRIDGE_START}
{
  "schemaVersion": "manual-bridge-turn.v1",
  "expectedRevision": ${expectedRevision},
  "operations": [],
  "readyEvaluation": {
    "criteria": ${JSON.stringify(criteria, null, 4).replace(/^/gm, "    ").trimStart()},
    "blockingUnknownIds": [],
    "summary": "Replace with a concise evaluation summary"
  }
}
${MANUAL_BRIDGE_END}

# UPDATE JSON SCHEMA
${JSON.stringify(schema, null, 2)}`;
}

function manualTurnToken(
  key: Buffer,
  projectId: string,
  stage: ReasoningStage,
  kind: ManualBridgeTurnKind,
  revision: number,
  recordVersion: number,
  userMessage: string
): string {
  return createHmac("sha256", key)
    .update(JSON.stringify({ projectId, stage, kind, revision, recordVersion, userMessage }))
    .digest("hex");
}

function validTurnToken(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

