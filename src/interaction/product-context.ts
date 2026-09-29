import type { ConfirmedProductState, ProjectRecord } from "../domain/types.js";
import { requireConfirmedProductState } from "../workflow/confirmed-product-state.js";

export interface InteractionSourceContext {
  sourceVersions: {
    discovery: number;
    solution: number;
    productSpecRevision: number;
    confirmedProductStateVersion: number;
    confirmedProductStateHash: string;
    prd: number;
  };
  confirmedProductState: ConfirmedProductState;
  prdRequirementDetails: string;
}

export function buildInteractionSourceContext(project: ProjectRecord): InteractionSourceContext {
  const confirmedProductState = requireConfirmedProductState(project);
  const prd = project.artifacts.prd;
  if (prd.lifecycleStatus !== "CURRENT" || prd.reviewStatus !== "CONFIRMED" || !prd.currentContent?.trim()) {
    throw new Error("PRD must be current and confirmed before generating Interaction Specification");
  }
  if (
    prd.sourceVersions?.confirmedProductStateHash !== undefined &&
    prd.sourceVersions.confirmedProductStateHash !== confirmedProductState.contentHash
  ) throw new Error("Confirmed PRD is based on a stale Confirmed Product State");
  return {
    sourceVersions: {
      ...confirmedProductState.sourceVersions,
      confirmedProductStateVersion: confirmedProductState.stateVersion,
      confirmedProductStateHash: confirmedProductState.contentHash,
      prd: prd.contentRevision
    },
    confirmedProductState: structuredClone(confirmedProductState),
    prdRequirementDetails: prd.currentContent
  };
}

export function renderInteractionContext(context: InteractionSourceContext): string {
  return [
    "# Confirmed Workflow Context",
    "The Confirmed Product State is the authoritative business source. The confirmed PRD is its detailed requirement expression. Do not create or change core business decisions.",
    `Source Versions: ${JSON.stringify(context.sourceVersions)}`,
    "## Confirmed Product State",
    JSON.stringify(context.confirmedProductState, null, 2),
    "## Confirmed PRD Requirement Details",
    context.prdRequirementDetails
  ].join("\n\n");
}
