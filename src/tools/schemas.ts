import { z } from "zod";

export const updateProductSpecSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  operations: z.array(z.object({
    op: z.enum(["ADD", "REPLACE", "REMOVE"]),
    path: z.string().trim().min(1),
    value: z.unknown().optional(),
    reason: z.string().optional()
  })).min(1).max(20),
  // ModelFlare may omit this descriptive field even when the tool schema marks
  // it required. It is observability metadata, not part of the state mutation,
  // so default it instead of rejecting an otherwise valid atomic update.
  summary: z.string().trim().min(1).default("Product Spec update")
});

export const manageOpenQuestionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  action: z.enum(["CREATE", "RESOLVE", "DEFER", "REOPEN"]),
  questionId: z.string().optional(),
  ownerStage: z.enum(["DISCOVERY", "SOLUTION", "INTERACTION"]).optional(),
  question: z.string().trim().min(1).optional(),
  impact: z.string().trim().min(1).optional(),
  blocking: z.boolean().optional(),
  resolutionMethod: z.enum([
    "DERIVE", "DEFAULT", "RESEARCH", "DATA_VALIDATION", "STAKEHOLDER_CONFIRMATION",
    "TECHNICAL_VALIDATION", "PRODUCT_DECISION", "DEFER"
  ]).optional(),
  resolution: z.string().trim().min(1).optional()
});

export const recordDecisionSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  decision: z.string().trim().min(1),
  rationale: z.array(z.string().trim().min(1)).min(1),
  affectedPaths: z.array(z.string().trim().min(1)).min(1),
  status: z.enum(["ACTIVE", "DEFERRED"]).optional(),
  supersedesDecisionId: z.string().optional()
});

export const requestValidationSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  type: z.enum(["RESEARCH", "DATA", "STAKEHOLDER", "TECHNICAL"]),
  question: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  blocking: z.boolean(),
  relatedOpenQuestionId: z.string().optional(),
  expectedOutput: z.string().trim().min(1).optional()
});

export const evaluateStageSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  criteria: z.array(z.object({
    criterionId: z.string().trim().min(1),
    status: z.enum(["SUFFICIENT", "PARTIAL", "MISSING", "NOT_APPLICABLE"]),
    reason: z.string().trim().min(1)
  })).min(1),
  blockingUnknownIds: z.array(z.string().trim().min(1)),
  summary: z.string().trim().min(1)
});

const turnUpdateProductSpecSchema = updateProductSpecSchema.omit({ expectedRevision: true }).extend({
  kind: z.literal("update_product_spec")
});
const turnManageOpenQuestionSchema = manageOpenQuestionSchema.omit({ expectedRevision: true }).extend({
  kind: z.literal("manage_open_question")
});
const turnRecordDecisionSchema = recordDecisionSchema.omit({ expectedRevision: true }).extend({
  kind: z.literal("record_decision"),
  reference: z.string().trim().min(1).regex(/^[A-Za-z0-9_-]+$/).optional()
});
const turnRequestValidationSchema = requestValidationSchema.omit({ expectedRevision: true }).extend({
  kind: z.literal("request_validation")
});

export const completeDiscoveryTurnSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  assistantResponse: z.string().trim().min(1),
  operations: z.array(z.discriminatedUnion("kind", [
    turnUpdateProductSpecSchema,
    turnManageOpenQuestionSchema,
    turnRecordDecisionSchema,
    turnRequestValidationSchema
  ])).max(20),
  readyEvaluation: evaluateStageSchema.omit({ expectedRevision: true })
});
