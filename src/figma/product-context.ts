import type { ConfirmedProductState, ProjectRecord } from "../domain/types.js";
import { requireConfirmedProductState } from "../workflow/confirmed-product-state.js";

export interface FigmaSourceContext {
  sourceVersions: {
    discovery: number;
    solution: number;
    prd: number;
    interaction: number;
    confirmedProductStateVersion: number;
    confirmedProductStateHash: string;
  };
  confirmedProductState: ConfirmedProductState;
  prdRequirementDetails: string;
  interactionSpecification: string;
}

export function buildFigmaSourceContext(project: ProjectRecord): FigmaSourceContext {
  const discovery = project.workflow.stages.DISCOVERY;
  const solution = project.workflow.stages.SOLUTION;
  const prd = project.artifacts.prd;
  const interaction = project.artifacts.interaction;
  const confirmedProductState = requireConfirmedProductState(project);
  if (prd.lifecycleStatus !== "CURRENT" || prd.reviewStatus !== "CONFIRMED" || !prd.currentContent?.trim()) {
    throw new Error("PRD must be current and confirmed before generating Figma Prompt");
  }
  if (prd.sourceVersions?.discovery !== discovery.confirmedVersion || prd.sourceVersions?.solution !== solution.confirmedVersion) {
    throw new Error("Confirmed PRD is based on stale Product Spec versions");
  }
  if (interaction.lifecycleStatus !== "CURRENT" || interaction.reviewStatus !== "CONFIRMED" || !interaction.currentContent?.trim()) {
    throw new Error("Interaction Specification must be current and confirmed before generating Figma Prompt");
  }
  if (interaction.sourceVersions?.prd !== prd.contentRevision) {
    throw new Error("Confirmed Interaction Specification is based on a stale PRD");
  }
  if (interaction.sourceVersions.confirmedProductStateHash !== confirmedProductState.contentHash) {
    throw new Error("Confirmed Interaction Specification is based on a stale Confirmed Product State");
  }
  return {
    sourceVersions: {
      discovery: discovery.confirmedVersion!,
      solution: solution.confirmedVersion!,
      prd: prd.contentRevision,
      interaction: interaction.contentRevision,
      confirmedProductStateVersion: confirmedProductState.stateVersion,
      confirmedProductStateHash: confirmedProductState.contentHash
    },
    confirmedProductState: structuredClone(confirmedProductState),
    prdRequirementDetails: prd.currentContent,
    interactionSpecification: interaction.currentContent
  };
}

export function renderFigmaProjectContext(context: FigmaSourceContext): string {
  return [
    "# Current Project Context",
    "This section is a deterministic projection of confirmed workflow data. Treat it as project facts. Do not add missing business rules.",
    `Source Versions: ${JSON.stringify(context.sourceVersions)}`,
    "## Project",
    JSON.stringify(context.confirmedProductState.project, null, 2),
    "## Confirmed PRD Requirement Details",
    context.prdRequirementDetails,
    "## Confirmed Product Solution",
    JSON.stringify(context.confirmedProductState.solution, null, 2),
    "## Discovery and Existing Product Baseline",
    JSON.stringify(context.confirmedProductState.discovery, null, 2),
    "## Confirmed Interaction Specification",
    context.interactionSpecification,
    "## Active Decisions",
    JSON.stringify(context.confirmedProductState.activeDecisions, null, 2),
    "## Relevant Open Questions",
    JSON.stringify(context.confirmedProductState.relevantOpenQuestions, null, 2),
    "## Relevant Evidence and Assumptions",
    JSON.stringify(context.confirmedProductState.evidenceAndAssumptions, null, 2)
  ].join("\n\n");
}

export function buildFigmaMetaContext(context: FigmaSourceContext) {
  const state = context.confirmedProductState;
  return {
    sourceVersions: context.sourceVersions,
    users: [
      ...state.discovery.users.primary.map(user => user.name),
      ...state.discovery.users.related.map(user => user.name)
    ],
    existingCapabilities: state.discovery.currentProduct.reusableCapabilities,
    constraints: state.discovery.constraints.map(constraint => constraint.description),
    solution: {
      summary: state.solution.summary,
      coreSolution: state.solution.coreSolution,
      mechanisms: state.solution.keyMechanisms.map(item => item.name),
      inScope: state.solution.scope.inScope,
      outOfScope: state.solution.scope.outOfScope,
      flow: state.solution.mainProductFlow.map(item => item.step)
    },
    prdOutline: markdownOutline(context.prdRequirementDetails),
    interactionOutline: markdownOutline(context.interactionSpecification)
  };
}

function markdownOutline(markdown: string): string[] {
  const headings = markdown.split(/\r?\n/)
    .map(line => line.match(/^#{1,4}\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set(headings)].slice(0, 80);
}
