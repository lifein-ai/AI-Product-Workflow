import type { Decision, ProjectRecord } from "../domain/types.js";
import { markStageContentChanged } from "./state-machine.js";

export interface DiscoveryConsistencyRepair {
  changed: boolean;
  warning?: string;
}

/**
 * Rebuilds the structured projection of an explicitly accepted Discovery
 * decision when a relay/model formatting difference caused the companion
 * behaviorChange write to be lost.
 *
 * The repair is deliberately narrow: it only runs for an ACTIVE Discovery
 * decision that explicitly declares discovery.behaviorChange as an affected
 * path, and it never overwrites an existing behaviorChange definition.
 */
export function reconcileDiscoveryDecisionProjection(project: ProjectRecord): DiscoveryConsistencyRepair {
  if (project.workflow.activeStage !== "DISCOVERY" || project.productSpec.discovery.behaviorChange) {
    return { changed: false };
  }

  const decision = [...project.productSpec.decisions].reverse().find(isBehaviorChangeDecision);
  if (!decision) return { changed: false };

  const targetBehavior = project.productSpec.discovery.scenarios.find(item => item.goal.trim())?.goal.trim()
    || project.productSpec.discovery.goals.primary?.trim();
  if (!targetBehavior) return { changed: false };

  project.productSpec.discovery.behaviorChange = {
    targetBehavior,
    basis: {
      type: "ACCEPTED_ASSUMPTION",
      assumption: decision.decision,
      evidenceStatus: "UNVALIDATED",
      decisionId: decision.id,
      validationIntent: "上线后通过相关真实行为数据验证该假设，并据此修正后续方案。"
    }
  };

  const timestamp = new Date().toISOString();
  project.productSpec.version.revision += 1;
  project.productSpec.version.updatedAt = timestamp;
  project.productSpec.project.updatedAt = timestamp;
  markStageContentChanged(project, "DISCOVERY");

  return {
    changed: true,
    warning: "Recovered discovery.behaviorChange from its linked active Discovery decision"
  };
}

function isBehaviorChangeDecision(decision: Decision): boolean {
  return decision.stage === "DISCOVERY"
    && decision.status === "ACTIVE"
    && decision.affectedPaths.some(path => path === "discovery.behaviorChange" || path.startsWith("discovery.behaviorChange."));
}
