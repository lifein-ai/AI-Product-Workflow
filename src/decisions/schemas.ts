import { z } from "zod";

export const DECISION_EXTRACTION_TOOL_NAME = "extract_decisions";

const alternativeSchema = z.object({
  option: z.string().trim().min(1),
  rejectionReason: z.string().trim().min(1).nullable()
}).strict();

export const decisionCandidateSchema = z.object({
  action: z.enum(["CREATE", "UPDATE", "SUPERSEDE", "IGNORE"]),
  targetDecisionId: z.string().trim().min(1).nullable(),
  feature: z.string().trim().min(1),
  topic: z.string().trim().min(1),
  decision: z.string().trim().min(1),
  reason: z.string().trim().min(1).nullable(),
  alternatives: z.array(alternativeSchema).max(20),
  importance: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  strength: z.enum(["EXPLICIT", "IMPLIED", "TENTATIVE"]),
  status: z.enum(["ACTIVE", "DEFERRED"]),
  sourceMessageIds: z.array(z.string().trim().min(1)).min(1)
}).strict();

export const decisionExtractionSchema = z.object({
  decisions: z.array(decisionCandidateSchema).max(20)
}).strict();

export type DecisionCandidate = z.infer<typeof decisionCandidateSchema>;

export const decisionExtractionTool = {
  type: "function",
  name: DECISION_EXTRACTION_TOOL_NAME,
  description: "Extract and merge durable product decisions from a batch of already-recorded project conversation messages.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["decisions"],
    properties: {
      decisions: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "action", "targetDecisionId", "feature", "topic", "decision", "reason",
            "alternatives", "importance", "strength", "status", "sourceMessageIds"
          ],
          properties: {
            action: { type: "string", enum: ["CREATE", "UPDATE", "SUPERSEDE", "IGNORE"] },
            targetDecisionId: { type: ["string", "null"] },
            feature: { type: "string" },
            topic: { type: "string" },
            decision: { type: "string" },
            reason: { type: ["string", "null"] },
            alternatives: {
              type: "array",
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["option", "rejectionReason"],
                properties: {
                  option: { type: "string" },
                  rejectionReason: { type: ["string", "null"] }
                }
              }
            },
            importance: { type: "integer", enum: [1, 2, 3] },
            strength: { type: "string", enum: ["EXPLICIT", "IMPLIED", "TENTATIVE"] },
            status: { type: "string", enum: ["ACTIVE", "DEFERRED"] },
            sourceMessageIds: { type: "array", minItems: 1, items: { type: "string" } }
          }
        }
      }
    }
  }
};
