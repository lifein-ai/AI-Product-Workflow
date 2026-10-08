import type { ProjectRecord, ReasoningStage, ReadyEvaluation } from "../domain/types.js";
import { discoverySpecSchema, solutionSpecSchema } from "../domain/product-spec-schema.js";
import { buildConfirmedProductState, invalidateConfirmedProductState } from "./confirmed-product-state.js";

const now = () => new Date().toISOString();

export function markStageContentChanged(project: ProjectRecord, stage: ReasoningStage): void {
  const state = project.workflow.stages[stage];
  state.contentVersion += 1;
  state.updatedAt = now();
  state.readyEvaluation = undefined;
  if (state.status === "READY_FOR_CONFIRMATION" || state.status === "CONFIRMED") {
    state.status = "IN_PROGRESS";
  }

  if (stage === "DISCOVERY") {
    invalidateConfirmedProductState(project);
    invalidateIfStarted(project, "SOLUTION");
    invalidateIfStarted(project, "INTERACTION");
    invalidatePrdArtifact(project);
  } else if (stage === "SOLUTION") {
    invalidateConfirmedProductState(project);
    invalidateIfStarted(project, "INTERACTION");
    invalidatePrdArtifact(project);
  }
}

function invalidatePrdArtifact(project: ProjectRecord): void {
  const artifact = project.artifacts.prd;
  if (artifact.lifecycleStatus === "CURRENT") {
    artifact.lifecycleStatus = "STALE";
    artifact.updatedAt = now();
  }
  invalidateInteractionArtifact(project);
}

export function invalidateInteractionArtifact(project: ProjectRecord): void {
  const artifact = project.artifacts.interaction;
  if (artifact.lifecycleStatus === "CURRENT") {
    artifact.lifecycleStatus = "STALE";
    artifact.updatedAt = now();
  }
  invalidateFigmaPromptArtifact(project);
}

export function invalidateFigmaPromptArtifact(project: ProjectRecord): void {
  const artifact = project.artifacts.figmaPrompt;
  if (artifact.lifecycleStatus === "CURRENT") {
    artifact.lifecycleStatus = "STALE";
    artifact.updatedAt = now();
  }
}

function invalidateIfStarted(project: ProjectRecord, stage: ReasoningStage): void {
  const state = project.workflow.stages[stage];
  if (state.status !== "NOT_STARTED") {
    state.status = "NEEDS_REVIEW";
    state.readyEvaluation = undefined;
    state.updatedAt = now();
  }
}

export function applyReadyEvaluation(project: ProjectRecord, stage: ReasoningStage, evaluation: ReadyEvaluation): void {
  const state = project.workflow.stages[stage];
  if (state.status !== "IN_PROGRESS") {
    throw new Error(`Cannot evaluate stage ${stage} from status ${state.status}`);
  }
  if (evaluation.evaluatedContentVersion !== state.contentVersion) {
    throw new Error(`Cannot apply stale evaluation for ${stage}`);
  }

  state.readyEvaluation = evaluation;
  state.updatedAt = now();
  if (evaluation.result === "READY") {
    state.status = "READY_FOR_CONFIRMATION";
  }
}

export function startStage(project: ProjectRecord, stage: ReasoningStage): void {
  if (stage !== "SOLUTION") throw new Error(`Stage ${stage} cannot be started by the V0 transition`);
  if (project.workflow.stages.DISCOVERY.status !== "CONFIRMED") {
    throw new Error("Discovery must be confirmed before starting Solution");
  }
  const state = project.workflow.stages[stage];
  if (state.status === "IN_PROGRESS" && project.workflow.activeStage === stage) return;
  if (state.status !== "NOT_STARTED") throw new Error(`Cannot start Solution from status ${state.status}`);
  state.status = "IN_PROGRESS";
  state.updatedAt = now();
  state.dependencySnapshot = { DISCOVERY: project.workflow.stages.DISCOVERY.confirmedVersion };
  project.workflow.activeStage = stage;
}

export function confirmStage(project: ProjectRecord, stage: ReasoningStage): void {
  const state = project.workflow.stages[stage];
  if (state.status !== "READY_FOR_CONFIRMATION" || !state.readyEvaluation) {
    throw new Error(`Stage ${stage} is not ready for confirmation`);
  }
  if (state.readyEvaluation.evaluatedContentVersion !== state.contentVersion) {
    throw new Error(`Stage ${stage} changed after ready evaluation`);
  }
  if (state.readyEvaluation.result !== "READY") throw new Error(`Stage ${stage} evaluation is not ready`);
  if (project.productSpec.openQuestions.some(question => question.ownerStage === stage && question.status === "OPEN" && question.blocking)) {
    throw new Error(`Stage ${stage} has blocking open questions`);
  }
  if (stage === "DISCOVERY") discoverySpecSchema.parse(project.productSpec.discovery);
  if (stage === "SOLUTION") {
    if (project.workflow.stages.DISCOVERY.status !== "CONFIRMED") throw new Error("Discovery must remain confirmed");
    solutionSpecSchema.parse(project.productSpec.solution);
  }
  state.status = "CONFIRMED";
  state.confirmedVersion = state.contentVersion;
  state.updatedAt = now();
  if (stage === "SOLUTION") {
    project.confirmedProductState = buildConfirmedProductState(project);
    project.workflow.activeStage = null;
  }
}

export function reopenSolution(project: ProjectRecord): void {
  const state = project.workflow.stages.SOLUTION;
  if (state.status === "IN_PROGRESS" && project.workflow.activeStage === "SOLUTION") return;
  if (state.status !== "CONFIRMED") throw new Error(`Cannot reopen Solution from status ${state.status}`);

  state.status = "IN_PROGRESS";
  state.readyEvaluation = undefined;
  state.confirmedVersion = undefined;
  state.updatedAt = now();
  project.workflow.activeStage = "SOLUTION";
  invalidateConfirmedProductState(project);

  const prd = project.artifacts.prd;
  if (prd.lifecycleStatus === "CURRENT" || prd.reviewStatus === "BLOCKED") {
    prd.lifecycleStatus = "STALE";
    prd.updatedAt = now();
  }
  invalidateInteractionArtifact(project);
}

export function reopenDiscovery(project: ProjectRecord): void {
  const state = project.workflow.stages.DISCOVERY;
  if (state.status === "IN_PROGRESS" && project.workflow.activeStage === "DISCOVERY") return;
  if (state.status !== "CONFIRMED") throw new Error(`Cannot reopen Discovery from status ${state.status}`);

  state.status = "IN_PROGRESS";
  state.readyEvaluation = undefined;
  state.confirmedVersion = undefined;
  state.updatedAt = now();
  project.workflow.activeStage = "DISCOVERY";
  invalidateConfirmedProductState(project);
  invalidateIfStarted(project, "SOLUTION");
  invalidateIfStarted(project, "INTERACTION");
  invalidatePrdArtifact(project);
}
