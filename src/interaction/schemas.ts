import { z } from "zod";

const nonempty = z.string().trim().min(1);

const interactionGenerationResultObjectSchema = z.strictObject({
  result: z.enum(["GENERATED", "NEEDS_INPUT"]),
  interactionSpecificationMarkdown: z.string().optional(),
  openQuestions: z.array(z.strictObject({
    question: nonempty,
    impact: nonempty,
    sourcePath: nonempty.optional(),
    scope: z.enum(["PRODUCT_DECISION", "ARTIFACT_DETAIL"]).optional()
  })),
  generationNotes: z.array(nonempty)
}).superRefine((value, context) => {
  if (value.result === "GENERATED" && !value.interactionSpecificationMarkdown?.trim()) {
    context.addIssue({
      code: "custom",
      path: ["interactionSpecificationMarkdown"],
      message: "GENERATED requires interactionSpecificationMarkdown"
    });
  }
});

export const interactionGenerationResultSchema = z.preprocess(value => {
  if (!value || typeof value !== "object" || Array.isArray(value) || "result" in value) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.interactionSpecificationMarkdown === "string" && record.interactionSpecificationMarkdown.trim()) {
    return { ...record, result: "GENERATED" };
  }
  if (Array.isArray(record.openQuestions) && record.openQuestions.length > 0) {
    return { ...record, result: "NEEDS_INPUT" };
  }
  return value;
}, interactionGenerationResultObjectSchema);

export type InteractionGenerationResult = z.infer<typeof interactionGenerationResultSchema>;
