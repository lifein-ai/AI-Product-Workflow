import type { Decision, SolutionSpec, StageCriterionEvaluation } from "../domain/types.js";

const hasText = (value: string | undefined) => !!value?.trim();

export function solutionExitCriteriaIssues(solution: SolutionSpec, criteria: StageCriterionEvaluation[], decisions: Decision[] = []): string[] {
  const issues: string[] = [];
  const status = new Map(criteria.map(item => [item.criterionId, item.status]));
  if (status.get("solution_summary") !== "SUFFICIENT" || !hasText(solution.summary)) issues.push("solution_summary requires solution.summary");
  if (status.get("core_solution") !== "SUFFICIENT" || !hasText(solution.coreSolution)) issues.push("core_solution requires solution.coreSolution");
  if (status.get("key_mechanisms") !== "SUFFICIENT" || solution.keyMechanisms.length === 0) issues.push("key_mechanisms requires at least one solution.keyMechanisms item");
  if (status.get("scope_clarity") !== "SUFFICIENT" || solution.scope.inScope.length === 0 || solution.scope.outOfScope.length === 0) {
    issues.push("scope_clarity requires both solution.scope.inScope and solution.scope.outOfScope");
  }
  if (status.get("key_rules") !== "SUFFICIENT" || solution.keyRules.length === 0) issues.push("key_rules requires at least one solution.keyRules item");
  if (status.get("main_product_flow") !== "SUFFICIENT" || solution.mainProductFlow.length === 0) issues.push("main_product_flow requires at least one solution.mainProductFlow item");
  if (status.get("tradeoff_clarity") !== "SUFFICIENT" || solution.tradeOffs.length === 0) issues.push("tradeoff_clarity requires at least one decided solution.tradeOffs item");
  const hasConfirmedTradeOff = decisions.some(decision =>
    decision.stage === "SOLUTION" && decision.status === "ACTIVE" && decision.affectedPaths.some(path => path === "solution.tradeOffs" || path.startsWith("solution.tradeOffs."))
  );
  if (!hasConfirmedTradeOff) issues.push("tradeoff_clarity requires an active Solution decision affecting solution.tradeOffs");
  if (status.get("handoff_readiness") !== "SUFFICIENT") issues.push("handoff_readiness must be SUFFICIENT for Interaction Design and PRD");
  return issues;
}
