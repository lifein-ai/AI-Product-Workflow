import { DISCOVERY_PROMPT } from "../prompts/discovery.js";
import { SOLUTION_PROMPT } from "../prompts/solution.js";
import type { ReasoningStage } from "../domain/types.js";

export interface StageConfig {
  id: ReasoningStage;
  prompt: string;
  ownedRoot: "discovery" | "solution" | "interaction";
  contextRoots: Array<"project" | "discovery" | "solution" | "interaction" | "openQuestions" | "decisions">;
  allowedTools: string[];
  modelTools: string[];
  exitCriteriaIds: string[];
}

export const stageRegistry: Record<ReasoningStage, StageConfig> = {
  DISCOVERY: {
    id: "DISCOVERY",
    prompt: DISCOVERY_PROMPT,
    ownedRoot: "discovery",
    contextRoots: ["project", "discovery", "openQuestions", "decisions"],
    allowedTools: [
      "update_product_spec",
      "manage_open_question",
      "record_decision",
      "request_validation",
      "evaluate_stage"
    ],
    modelTools: ["complete_discovery_turn"],
    exitCriteriaIds: [
      "problem_clarity",
      "user_clarity",
      "scenario_clarity",
      "goal_clarity",
      "behavior_change_basis",
      "current_product_clarity",
      "direction_clarity",
      "scope_clarity",
      "constraint_clarity",
      "evidence_sufficiency"
    ]
  },
  SOLUTION: {
    id: "SOLUTION",
    prompt: SOLUTION_PROMPT,
    ownedRoot: "solution",
    contextRoots: ["project", "discovery", "solution", "openQuestions", "decisions"],
    allowedTools: [
      "update_product_spec",
      "manage_open_question",
      "record_decision",
      "request_validation",
      "evaluate_stage"
    ],
    modelTools: ["complete_solution_turn"],
    exitCriteriaIds: [
      "solution_summary",
      "core_solution",
      "key_mechanisms",
      "scope_clarity",
      "key_rules",
      "main_product_flow",
      "tradeoff_clarity",
      "handoff_readiness"
    ]
  },
  INTERACTION: {
    id: "INTERACTION",
    prompt: "Interaction Stage is intentionally not implemented in V0 runtime.",
    ownedRoot: "interaction",
    contextRoots: ["project", "solution", "interaction", "openQuestions", "decisions"],
    allowedTools: [],
    modelTools: [],
    exitCriteriaIds: []
  }
};
