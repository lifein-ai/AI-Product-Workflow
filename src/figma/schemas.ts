import { z } from "zod";

const nonempty = z.string().trim().min(1);

export const figmaMetaPlanSchema = z.strictObject({
  schemaVersion: z.literal("figma-meta-plan.v1"),
  analysis: z.strictObject({
    taskType: nonempty,
    pageTypes: z.array(nonempty),
    coreCapabilities: z.array(nonempty)
  }),
  selection: z.strictObject({
    baseId: nonempty,
    domainCapabilityIds: z.array(nonempty),
    supportCapabilityIds: z.array(nonempty)
  }),
  capabilityGaps: z.array(z.strictObject({
    capabilityName: nonempty,
    reason: nonempty,
    existingPromptId: nonempty.optional()
  })),
  canAssemble: z.boolean(),
  blockingIssues: z.array(nonempty)
});

