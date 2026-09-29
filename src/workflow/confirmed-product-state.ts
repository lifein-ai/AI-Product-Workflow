import { createHash } from "node:crypto";
import type { ConfirmedProductState, ProjectRecord } from "../domain/types.js";

const now = () => new Date().toISOString();

export function buildConfirmedProductState(project: ProjectRecord): ConfirmedProductState {
  const discoveryState = project.workflow.stages.DISCOVERY;
  const solutionState = project.workflow.stages.SOLUTION;
  if (discoveryState.status !== "CONFIRMED" || discoveryState.confirmedVersion === undefined) {
    throw new Error("Discovery must be confirmed before building Confirmed Product State");
  }
  if (solutionState.status !== "CONFIRMED" || solutionState.confirmedVersion === undefined) {
    throw new Error("Product Solution must be confirmed before building Confirmed Product State");
  }
  const blocking = project.productSpec.openQuestions.filter(question =>
    question.status === "OPEN" && question.blocking && (question.ownerStage === "DISCOVERY" || question.ownerStage === "SOLUTION")
  );
  if (blocking.length > 0) throw new Error("Confirmed Product State cannot contain blocking Decision Layer questions");

  const content = {
    project: {
      id: project.productSpec.project.id,
      initialRequirement: project.productSpec.project.initialRequirement
    },
    discovery: structuredClone(project.productSpec.discovery),
    solution: structuredClone(project.productSpec.solution),
    activeDecisions: structuredClone(project.productSpec.decisions.filter(decision =>
      decision.status === "ACTIVE" && (decision.stage === "DISCOVERY" || decision.stage === "SOLUTION")
    )),
    relevantOpenQuestions: structuredClone(project.productSpec.openQuestions.filter(question =>
      question.status === "OPEN" && !question.blocking && (question.ownerStage === "DISCOVERY" || question.ownerStage === "SOLUTION")
    )),
    evidenceAndAssumptions: projectEvidenceAndAssumptions(project)
  };
  const body = {
    schemaVersion: "confirmed-product-state.v1" as const,
    stateVersion: (project.confirmedProductState?.stateVersion ?? 0) + 1,
    lifecycleStatus: "CURRENT" as const,
    sourceVersions: {
      discovery: discoveryState.confirmedVersion,
      solution: solutionState.confirmedVersion,
      productSpecRevision: project.productSpec.version.revision
    },
    ...content,
    confirmedAt: now()
  };
  return {
    ...body,
    contentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex")
  };
}

export function requireConfirmedProductState(project: ProjectRecord): ConfirmedProductState {
  const existing = project.confirmedProductState;
  if (existing?.lifecycleStatus === "CURRENT") {
    const discovery = project.workflow.stages.DISCOVERY;
    const solution = project.workflow.stages.SOLUTION;
    if (
      discovery.status === "CONFIRMED" &&
      solution.status === "CONFIRMED" &&
      existing.sourceVersions.discovery === discovery.confirmedVersion &&
      existing.sourceVersions.solution === solution.confirmedVersion &&
      existing.sourceVersions.productSpecRevision === project.productSpec.version.revision
    ) return existing;
    existing.lifecycleStatus = "STALE";
  }
  if (!existing && project.workflow.stages.DISCOVERY.status === "CONFIRMED" && project.workflow.stages.SOLUTION.status === "CONFIRMED") {
    project.confirmedProductState = buildConfirmedProductState(project);
    return project.confirmedProductState;
  }
  throw new Error("Confirmed Product State is not current");
}

export function invalidateConfirmedProductState(project: ProjectRecord): void {
  if (project.confirmedProductState?.lifecycleStatus === "CURRENT") {
    project.confirmedProductState.lifecycleStatus = "STALE";
  }
}

function projectEvidenceAndAssumptions(project: ProjectRecord): ConfirmedProductState["evidenceAndAssumptions"] {
  const evidence: ConfirmedProductState["evidenceAndAssumptions"]["evidence"] = [];
  const assumptions: ConfirmedProductState["evidenceAndAssumptions"]["assumptions"] = [];
  const validationIntents: ConfirmedProductState["evidenceAndAssumptions"]["validationIntents"] = [];
  const basis = project.productSpec.discovery.behaviorChange?.basis;
  if (basis?.type === "EVIDENCED_FRICTION") {
    evidence.push({ sourcePath: "discovery.behaviorChange.basis", value: structuredClone(basis) });
  } else if (basis?.type === "ACCEPTED_ASSUMPTION") {
    assumptions.push({ sourcePath: "discovery.behaviorChange.basis", value: structuredClone(basis) });
    validationIntents.push({ sourcePath: "discovery.behaviorChange.basis.validationIntent", value: basis.validationIntent });
  }
  for (const [index, hypothesis] of project.productSpec.discovery.hypotheses.entries()) {
    assumptions.push({ sourcePath: `discovery.hypotheses.${index}`, value: structuredClone(hypothesis) });
  }
  for (const [index, assumption] of project.productSpec.solution.assumptions.entries()) {
    assumptions.push({ sourcePath: `solution.assumptions.${index}`, value: structuredClone(assumption) });
    if (assumption.validationIntent) {
      validationIntents.push({ sourcePath: `solution.assumptions.${index}.validationIntent`, value: assumption.validationIntent });
    }
  }
  for (const question of project.productSpec.openQuestions) {
    if (question.status === "OPEN" && question.validation) {
      validationIntents.push({ sourcePath: `openQuestions.${question.id}.validation`, value: structuredClone(question.validation) });
    }
  }
  return { evidence, assumptions, validationIntents };
}
