import { randomUUID } from "node:crypto";
import type { PrdGenerationQuestion, ProjectRecord } from "../domain/types.js";
import { markStageContentChanged } from "../workflow/state-machine.js";

export const GENERATION_QUESTION_SCOPE_GUIDANCE = [
  "Classify a question as PRODUCT_DECISION only when different answers would materially change confirmed product scope, role permissions, the business state machine, the core end-to-end flow, or a key business rule.",
  "Classify page composition, field presentation, component choice, labels, helper/error copy, ordinary navigation placement, visual state expression, and other document or interaction details as ARTIFACT_DETAIL when they do not change confirmed product behavior.",
  "Do not promote a question merely because its sourcePath is under solution or discovery. When uncertain, keep the question in the current artifact as ARTIFACT_DETAIL."
].join(" ");

export function normalizeGenerationQuestions<T extends { openQuestions: PrdGenerationQuestion[] }>(generation: T): T {
  return {
    ...generation,
    openQuestions: generation.openQuestions.map(question => ({
      ...question,
      scope: question.scope ?? "ARTIFACT_DETAIL"
    }))
  };
}

export function routeProductDecisionQuestions(
  project: ProjectRecord,
  questions: PrdGenerationQuestion[],
  artifact: "PRD" | "INTERACTION"
): void {
  const productQuestions = questions.filter(question => question.scope === "PRODUCT_DECISION");
  if (productQuestions.length === 0) return;
  let created = false;
  for (const question of productQuestions) {
    const duplicate = project.productSpec.openQuestions.some(existing =>
      existing.ownerStage === "SOLUTION" && existing.status === "OPEN" && existing.question === question.question
    );
    if (duplicate) continue;
    project.productSpec.openQuestions.push({
      id: randomUUID(),
      createdInStage: "SOLUTION",
      ownerStage: "SOLUTION",
      question: question.question,
      impact: question.impact,
      blocking: true,
      resolutionMethod: "PRODUCT_DECISION",
      status: "OPEN",
      source: { type: "GENERATION", artifact, ...(question.sourcePath ? { sourcePath: question.sourcePath } : {}) }
    });
    created = true;
  }
  if (!created) return;
  const timestamp = new Date().toISOString();
  project.productSpec.version.revision += 1;
  project.productSpec.version.updatedAt = timestamp;
  project.productSpec.project.updatedAt = timestamp;
  markStageContentChanged(project, "SOLUTION");
  project.workflow.activeStage = "SOLUTION";
}
