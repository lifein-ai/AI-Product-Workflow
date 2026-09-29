import { z } from "zod";

const nonempty = z.string().trim().min(1);
const actor = z.strictObject({ id: nonempty, name: nonempty, description: z.string().optional() });

export const discoverySpecSchema = z.strictObject({
  background: z.strictObject({
    requirementSource: z.string().optional(), whyNow: z.string().optional(), context: z.string().optional()
  }).optional(),
  problem: z.strictObject({ statement: nonempty, impact: z.array(z.string()).optional() }).optional(),
  users: z.strictObject({ primary: z.array(actor), related: z.array(actor) }),
  scenarios: z.array(z.strictObject({
    id: nonempty, actorId: nonempty, trigger: z.string().optional(), context: nonempty,
    goal: nonempty, currentProblem: z.string().optional()
  })),
  goals: z.strictObject({ primary: z.string().optional(), secondary: z.array(z.string()) }),
  behaviorChange: z.strictObject({
    targetBehavior: nonempty,
    basis: z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("EVIDENCED_FRICTION"),
        friction: nonempty,
        evidence: z.array(nonempty).min(1)
      }),
      z.strictObject({
        type: z.literal("ACCEPTED_ASSUMPTION"),
        assumption: nonempty,
        evidenceStatus: z.enum(["LIMITED", "UNVALIDATED"]),
        decisionId: nonempty,
        validationIntent: nonempty
      })
    ])
  }).optional(),
  currentProduct: z.strictObject({
    capabilities: z.array(z.string()), currentFlow: z.string().optional(),
    reusableCapabilities: z.array(z.string()), limitations: z.array(z.string()), problems: z.array(z.string())
  }),
  direction: z.strictObject({ summary: nonempty, rationale: z.array(z.string()) }).optional(),
  constraints: z.array(z.strictObject({
    id: nonempty, type: z.enum(["BUSINESS", "TECHNICAL", "RESOURCE", "VERSION", "COMPLIANCE", "OTHER"]), description: nonempty
  })),
  scope: z.strictObject({ mustSolve: z.array(z.string()), canDefer: z.array(z.string()), outOfScope: z.array(z.string()) }),
  hypotheses: z.array(z.strictObject({ id: nonempty, statement: nonempty, rationale: z.string().optional() }))
});

export const solutionSpecSchema = z.strictObject({
  summary: z.string().optional(),
  coreSolution: z.string().optional(),
  keyMechanisms: z.array(z.strictObject({ id: nonempty, name: nonempty, description: nonempty })),
  scope: z.strictObject({ inScope: z.array(z.string()), outOfScope: z.array(z.string()) }),
  keyRules: z.array(z.strictObject({ id: nonempty, rule: nonempty, rationale: z.string().optional() })),
  mainProductFlow: z.array(z.strictObject({
    id: nonempty, step: nonempty, actor: z.string().optional(), outcome: z.string().optional()
  })),
  tradeOffs: z.array(z.strictObject({
    id: nonempty, topic: nonempty, decision: nonempty, rationale: nonempty, alternatives: z.array(z.string()).optional()
  })),
  risks: z.array(z.strictObject({ id: nonempty, risk: nonempty, mitigation: z.string().optional() })),
  assumptions: z.array(z.strictObject({ id: nonempty, assumption: nonempty, validationIntent: z.string().optional() }))
});
