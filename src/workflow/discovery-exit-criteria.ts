import type { Decision, DiscoverySpec, StageCriterionEvaluation } from "../domain/types.js";

const hasText = (value: string | undefined) => !!value?.trim();
const hasAny = (values: string[]) => values.some(hasText);

const behaviorGoalPattern = /\b(adoption|participation|retention|conversion|activation|engagement|usage)\b|(?:采用|参与|留存|转化|使用|激活|活跃|复购|流失)率|(?:促进|提高|增加|降低|让更多).+(?:采用|参与|留存|转化|使用|激活|活跃|复购|流失)/iu;

export function isBehaviorChangeGoal(discovery: DiscoverySpec): boolean {
  const goals = [discovery.goals.primary, ...discovery.goals.secondary].filter(hasText).join(" ");
  return !!discovery.behaviorChange || behaviorGoalPattern.test(goals);
}

export function discoveryExitCriteriaIssues(
  discovery: DiscoverySpec,
  criteria: StageCriterionEvaluation[],
  decisions: Decision[] = []
): string[] {
  const issues: string[] = [];
  const status = new Map(criteria.map(item => [item.criterionId, item.status]));
  if (status.get("problem_clarity") !== "SUFFICIENT" || !hasText(discovery.problem?.statement)) issues.push("problem_clarity requires discovery.problem.statement");
  if (status.get("user_clarity") !== "SUFFICIENT" || discovery.users.primary.length === 0) issues.push("user_clarity requires at least one discovery.users.primary item");
  if (status.get("scenario_clarity") !== "SUFFICIENT" || discovery.scenarios.length === 0) issues.push("scenario_clarity requires at least one discovery.scenarios item");
  if (discovery.scenarios.some(scenario => !discovery.users.primary.concat(discovery.users.related).some(actor => actor.id === scenario.actorId))) issues.push("every scenario.actorId must reference a known actor");
  if (status.get("goal_clarity") !== "SUFFICIENT" || !hasText(discovery.goals.primary)) issues.push("goal_clarity requires discovery.goals.primary");

  if (isBehaviorChangeGoal(discovery)) {
    if (status.get("behavior_change_basis") !== "SUFFICIENT") {
      issues.push("behavior_change_basis must be SUFFICIENT for adoption, participation, retention, or conversion goals");
    }
    const behaviorChange = discovery.behaviorChange;
    if (!behaviorChange) {
      issues.push("behavior-change goals require discovery.behaviorChange");
    } else if (behaviorChange.basis.type === "ACCEPTED_ASSUMPTION") {
      const decisionId = behaviorChange.basis.decisionId;
      const decision = decisions.find(item => item.id === decisionId);
      if (!decision || decision.stage !== "DISCOVERY" || decision.status !== "ACTIVE" || !decision.affectedPaths.includes("discovery.behaviorChange")) {
        issues.push("accepted behavior assumption must reference an active Discovery decision that affects discovery.behaviorChange");
      }
    }
  }
  if (status.get("direction_clarity") !== "SUFFICIENT" || !hasText(discovery.direction?.summary)) issues.push("direction_clarity requires discovery.direction.summary");
  if (status.get("scope_clarity") !== "SUFFICIENT" || !hasAny(discovery.scope.mustSolve)) issues.push("scope_clarity requires discovery.scope.mustSolve");

  const currentProduct = status.get("current_product_clarity");
  if (currentProduct !== "SUFFICIENT" && currentProduct !== "NOT_APPLICABLE") issues.push("current_product_clarity must be SUFFICIENT or NOT_APPLICABLE");
  if (currentProduct === "SUFFICIENT" && !(
    hasAny(discovery.currentProduct.capabilities) || hasText(discovery.currentProduct.currentFlow) ||
    hasAny(discovery.currentProduct.limitations) || hasAny(discovery.currentProduct.problems)
  )) issues.push("current_product_clarity marked SUFFICIENT requires current product content");

  const constraints = status.get("constraint_clarity");
  if (constraints !== "SUFFICIENT" && constraints !== "NOT_APPLICABLE") issues.push("constraint_clarity must be SUFFICIENT or NOT_APPLICABLE");
  if (constraints === "SUFFICIENT" && discovery.constraints.length === 0) issues.push("constraint_clarity marked SUFFICIENT requires discovery.constraints content");

  const evidence = status.get("evidence_sufficiency");
  if (evidence !== "SUFFICIENT" && evidence !== "NOT_APPLICABLE") issues.push("evidence_sufficiency must be SUFFICIENT or NOT_APPLICABLE");
  return issues;
}

export function discoveryExitCriteriaPass(discovery: DiscoverySpec, criteria: StageCriterionEvaluation[], decisions: Decision[] = []): boolean {
  return discoveryExitCriteriaIssues(discovery, criteria, decisions).length === 0;
}
