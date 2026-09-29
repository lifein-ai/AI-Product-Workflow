import type { ConfirmedProductState, ProjectRecord } from "../domain/types.js";
import { requireConfirmedProductState } from "../workflow/confirmed-product-state.js";

export interface PrdSourceContext {
  sourceVersions: {
    discovery: number;
    solution: number;
    productSpecRevision: number;
    confirmedProductStateVersion: number;
    confirmedProductStateHash: string;
  };
  confirmedProductState: ConfirmedProductState;
}

export function buildPrdSourceContext(project: ProjectRecord): PrdSourceContext {
  const confirmedProductState = requireConfirmedProductState(project);

  return {
    sourceVersions: {
      ...confirmedProductState.sourceVersions,
      confirmedProductStateVersion: confirmedProductState.stateVersion,
      confirmedProductStateHash: confirmedProductState.contentHash
    },
    confirmedProductState: structuredClone(confirmedProductState)
  };
}

export function renderCurrentProjectContext(context: PrdSourceContext): string {
  return [
    "# Current Project Context",
    "This section is a deterministic projection of the confirmed Product Spec. Treat it as project facts and do not infer missing business rules.",
    `Source Versions: ${JSON.stringify(context.sourceVersions)}`,
    "## Project",
    JSON.stringify(context.confirmedProductState.project, null, 2),
    "## Confirmed Discovery",
    JSON.stringify(context.confirmedProductState.discovery, null, 2),
    "## Confirmed Product Solution",
    JSON.stringify(context.confirmedProductState.solution, null, 2),
    "## Active Decisions",
    JSON.stringify(context.confirmedProductState.activeDecisions, null, 2),
    "## Relevant Open Questions",
    JSON.stringify(context.confirmedProductState.relevantOpenQuestions, null, 2),
    "## Relevant Evidence and Assumptions",
    JSON.stringify(context.confirmedProductState.evidenceAndAssumptions, null, 2)
  ].join("\n\n");
}

export function buildPrdMetaContext(context: PrdSourceContext) {
  const state = context.confirmedProductState;
  return {
    sourceVersions: context.sourceVersions,
    project: { id: state.project.id },
    users: {
      primary: state.discovery.users.primary.map(user => user.name),
      related: state.discovery.users.related.map(user => user.name)
    },
    scenarios: state.discovery.scenarios.map(scenario => ({
      actorId: scenario.actorId,
      context: scenario.context,
      goal: scenario.goal
    })),
    currentProduct: {
      capabilities: state.discovery.currentProduct.capabilities,
      reusableCapabilities: state.discovery.currentProduct.reusableCapabilities,
      limitations: state.discovery.currentProduct.limitations
    },
    constraints: state.discovery.constraints.map(constraint => ({ type: constraint.type, description: constraint.description })),
    solution: {
      summary: state.solution.summary,
      coreSolution: state.solution.coreSolution,
      mechanisms: state.solution.keyMechanisms.map(item => ({ name: item.name, description: item.description })),
      inScope: state.solution.scope.inScope,
      outOfScope: state.solution.scope.outOfScope,
      keyRules: state.solution.keyRules.map(item => item.rule),
      flow: state.solution.mainProductFlow.map(item => ({ step: item.step, actor: item.actor, outcome: item.outcome }))
    },
    activeDecisionStatements: state.activeDecisions.map(decision => decision.decision)
  };
}
