import { z } from "zod";

const nonempty = z.string().trim().min(1);

export const prdMetaPlanSchema = z.strictObject({
  schemaVersion: z.literal("prd-meta-plan.v1"),
  analysis: z.strictObject({
    requirementType: nonempty,
    domains: z.array(nonempty),
    coreObjects: z.array(nonempty),
    roles: z.array(nonempty),
    goal: nonempty
  }),
  selection: z.strictObject({
    baseId: nonempty,
    domainCapabilityIds: z.array(nonempty),
    generalCapabilityIds: z.array(nonempty),
    supportCapabilityIds: z.array(nonempty),
    projectPromptIds: z.array(nonempty)
  }),
  capabilityGaps: z.array(z.strictObject({
    capabilityName: nonempty,
    reason: nonempty,
    existingPromptId: nonempty.optional()
  })),
  canGenerate: z.boolean(),
  blockingIssues: z.array(nonempty)
});

const prdGenerationResultObjectSchema = z.strictObject({
  result: z.enum(["GENERATED", "NEEDS_INPUT"]),
  requirementDetailsMarkdown: z.string().optional(),
  openQuestions: z.array(z.strictObject({
    question: nonempty,
    impact: nonempty,
    sourcePath: nonempty.optional(),
    scope: z.enum(["PRODUCT_DECISION", "ARTIFACT_DETAIL"]).optional()
  })),
  generationNotes: z.array(nonempty)
}).superRefine((value, context) => {
  if (value.result === "GENERATED" && !value.requirementDetailsMarkdown?.trim()) {
    context.addIssue({
      code: "custom",
      path: ["requirementDetailsMarkdown"],
      message: "GENERATED requires requirementDetailsMarkdown"
    });
  }
});

export const prdGenerationResultSchema = z.preprocess(value => inferGenerationResult(value, "requirementDetailsMarkdown"), prdGenerationResultObjectSchema);

function inferGenerationResult(value: unknown, contentKey: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || "result" in value) return value;
  const record = value as Record<string, unknown>;
  if (typeof record[contentKey] === "string" && record[contentKey].trim()) {
    return { ...record, result: "GENERATED" };
  }
  if (Array.isArray(record.openQuestions) && record.openQuestions.length > 0) {
    return { ...record, result: "NEEDS_INPUT" };
  }
  return value;
}

export type PrdGenerationResult = z.infer<typeof prdGenerationResultSchema>;
