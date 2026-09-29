const atomicModelTools = [
  {
    type: "function",
    name: "update_product_spec",
    description: "Apply small, explicit mutations to current stage-owned Product Spec fields. Paths may be stage-relative or start with the owned root, and may use dots or slashes. ADD to an existing array accepts one item or an array. Discovery shapes: users item={id,name,description?}; scenarios item={id,actorId,trigger?,context,goal,currentProblem?}; constraints item={id,type,description}, where type MUST be exactly BUSINESS, TECHNICAL, RESOURCE, VERSION, COMPLIANCE, or OTHER; hypotheses item={id,statement,rationale?}; problem={statement,impact?:string[]}; direction={summary,rationale:string[]}; behaviorChange EVIDENCED_FRICTION basis={type:'EVIDENCED_FRICTION',friction,evidence:string[]} and evidence MUST remain an array even when there is one item. Solution shapes: keyMechanisms item={id,name,description}; keyRules item={id,rule,rationale?}; mainProductFlow item={id,step,actor?,outcome?}; tradeOffs item={id,topic,decision,rationale,alternatives?:string[]}; risks item={id,risk,mitigation?}; assumptions item={id,assumption,validationIntent?}; scope.inScope and scope.outOfScope are string arrays. If an optional object or string is absent, REPLACE the whole field. Use only sufficiently established facts or clearly labeled assumptions.",
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["expectedRevision", "operations", "summary"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["op", "path"],
            properties: {
              op: { type: "string", enum: ["ADD", "REPLACE", "REMOVE"] },
              path: { type: "string" },
              value: {},
              reason: { type: "string" }
            }
          }
        },
        summary: { type: "string" }
      }
    }
  },
  {
    type: "function",
    name: "manage_open_question",
    description: "Create, resolve, defer, or reopen an important unknown. CREATE must include question, impact, blocking, and resolutionMethod. Set blocking=true only when the unresolved answer can materially change the Solution Direction, primary scope, target user, or behavior-change basis. Ordinary downstream unknowns stay non-blocking. RESOLVE must include questionId and resolution. DEFER and REOPEN must include questionId. Do not create questions for low-value detail.",
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["expectedRevision", "action"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        action: { type: "string", enum: ["CREATE", "RESOLVE", "DEFER", "REOPEN"] },
        questionId: { type: "string" },
        ownerStage: { type: "string", enum: ["DISCOVERY", "SOLUTION", "INTERACTION"] },
        question: { type: "string" },
        impact: { type: "string" },
        blocking: { type: "boolean" },
        resolutionMethod: { type: "string", enum: ["DERIVE", "DEFAULT", "RESEARCH", "DATA_VALIDATION", "STAKEHOLDER_CONFIRMATION", "TECHNICAL_VALIDATION", "PRODUCT_DECISION", "DEFER"] },
        resolution: { type: "string" }
      }
    }
  },
  {
    type: "function",
    name: "record_decision",
    description: "Record a meaningful confirmed product decision and rationale in the active stage. In Discovery, an unsupported behavior-change assumption may be accepted only when the user explicitly chooses it. In Solution, record explicit choices about mechanisms, scope, rules, or trade-offs. Do not use for ordinary facts.",
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["expectedRevision", "decision", "rationale", "affectedPaths"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        decision: { type: "string" },
        rationale: { type: "array", items: { type: "string" } },
        affectedPaths: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["ACTIVE", "DEFERRED"], description: "Use DEFERRED only when the user explicitly postpones this choice. Deferred decisions never affect downstream generation." },
        supersedesDecisionId: { type: "string" }
      }
    }
  },
  {
    type: "function",
    name: "request_validation",
    description: "Create a request for research, data, stakeholder, or technical validation when the answer should not be guessed by the user or model. Such questions should normally be assigned to the relevant validator rather than asked conversationally. Use relatedOpenQuestionId when this validation replaces an existing unknown, and defer the old question separately.",
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["expectedRevision", "type", "question", "reason", "blocking"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        type: { type: "string", enum: ["RESEARCH", "DATA", "STAKEHOLDER", "TECHNICAL"] },
        question: { type: "string" },
        reason: { type: "string" },
        blocking: { type: "boolean" },
        relatedOpenQuestionId: { type: "string" },
        expectedOutput: { type: "string" }
      }
    }
  },
  {
    type: "function",
    name: "evaluate_stage",
    description: "Evaluate the current stage against its exit criteria. This may mark a stage ready for user confirmation but can never confirm or transition it.",
    strict: false,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["expectedRevision", "criteria", "blockingUnknownIds", "summary"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        criteria: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["criterionId", "status", "reason"],
            properties: {
              criterionId: { type: "string", enum: ["problem_clarity", "user_clarity", "scenario_clarity", "goal_clarity", "behavior_change_basis", "current_product_clarity", "direction_clarity", "scope_clarity", "constraint_clarity", "evidence_sufficiency"] },
              status: { type: "string", enum: ["SUFFICIENT", "PARTIAL", "MISSING", "NOT_APPLICABLE"] },
              reason: { type: "string" }
            }
          }
        },
        blockingUnknownIds: { type: "array", items: { type: "string" } },
        summary: { type: "string" }
      }
    }
  }
];

function withoutExpectedRevision(toolName: string) {
  const tool = atomicModelTools.find(item => item.name === toolName)!;
  const { expectedRevision: _expectedRevision, ...properties } = tool.parameters.properties;
  const operationProperties: Record<string, unknown> = {
    kind: { type: "string", enum: [toolName] },
    ...properties
  };
  if (toolName === "record_decision") {
    operationProperties.reference = {
      type: "string",
      pattern: "^[A-Za-z0-9_-]+$",
      description: "Optional local reference. A later Product Spec value may use the exact string $decision:<reference>; the server replaces it with the created Decision ID."
    };
  }
  return {
    type: "object",
    description: tool.description,
    additionalProperties: false,
    required: ["kind", ...tool.parameters.required.filter(name => name !== "expectedRevision")],
    properties: operationProperties
  };
}

const evaluateStageTool = atomicModelTools.find(item => item.name === "evaluate_stage")!;

function completeTurnTool(name: string, stage: string, criteriaIds: string[]) {
  return {
  type: "function",
  name,
  description: `Complete one ${stage} user turn in a single model call. Return the concise assistant response, every state mutation needed for this turn in execution order, and one Ready evaluation. The server executes all operations atomically, validates domain invariants, and makes the final Ready decision. Do not wait for tool results and do not call atomic tools separately.`,
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["expectedRevision", "assistantResponse", "operations", "readyEvaluation"],
    properties: {
      expectedRevision: { type: "integer", minimum: 0 },
      assistantResponse: {
        type: "string",
        description: "The complete user-facing response for this turn. Ask only the highest-value question(s). Do not claim that the server marked the stage Ready."
      },
      operations: {
        type: "array",
        maxItems: 20,
        description: "All deterministic state changes for this turn, in execution order. Record a referenced decision before using $decision:<reference> in a later Product Spec update.",
        items: {
          anyOf: [
            withoutExpectedRevision("update_product_spec"),
            withoutExpectedRevision("manage_open_question"),
            withoutExpectedRevision("record_decision"),
            withoutExpectedRevision("request_validation")
          ]
        }
      },
      readyEvaluation: {
        type: "object",
        description: evaluateStageTool.description,
        additionalProperties: false,
        required: ["criteria", "blockingUnknownIds", "summary"],
        properties: {
          criteria: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["criterionId", "status", "reason"],
              properties: {
                criterionId: { type: "string", enum: criteriaIds },
                status: { type: "string", enum: ["SUFFICIENT", "PARTIAL", "MISSING", "NOT_APPLICABLE"] },
                reason: { type: "string" }
              }
            }
          },
          blockingUnknownIds: { type: "array", items: { type: "string" } },
          summary: { type: "string" }
        }
      }
    }
  }
  };
}

const completeDiscoveryTurnTool = completeTurnTool("complete_discovery_turn", "Discovery", [
  "problem_clarity", "user_clarity", "scenario_clarity", "goal_clarity", "behavior_change_basis",
  "current_product_clarity", "direction_clarity", "scope_clarity", "constraint_clarity", "evidence_sufficiency"
]);
const completeSolutionTurnTool = completeTurnTool("complete_solution_turn", "Product Solution", [
  "solution_summary", "core_solution", "key_mechanisms", "scope_clarity", "key_rules",
  "main_product_flow", "tradeoff_clarity", "handoff_readiness"
]);

const completePrdMetaAnalysisTool = {
  type: "function",
  name: "complete_prd_meta_analysis",
  description: "Return the executable PRD Prompt selection plan. Select only registry IDs; do not return prompt contents or generate PRD text.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "analysis", "selection", "capabilityGaps", "canGenerate", "blockingIssues"],
    properties: {
      schemaVersion: { type: "string", enum: ["prd-meta-plan.v1"] },
      analysis: {
        type: "object",
        additionalProperties: false,
        required: ["requirementType", "domains", "coreObjects", "roles", "goal"],
        properties: {
          requirementType: { type: "string" },
          domains: { type: "array", items: { type: "string" } },
          coreObjects: { type: "array", items: { type: "string" } },
          roles: { type: "array", items: { type: "string" } },
          goal: { type: "string" }
        }
      },
      selection: {
        type: "object",
        additionalProperties: false,
        required: ["baseId", "domainCapabilityIds", "generalCapabilityIds", "supportCapabilityIds", "projectPromptIds"],
        properties: {
          baseId: { type: "string" },
          domainCapabilityIds: { type: "array", items: { type: "string" } },
          generalCapabilityIds: { type: "array", items: { type: "string" } },
          supportCapabilityIds: { type: "array", items: { type: "string" } },
          projectPromptIds: { type: "array", items: { type: "string" } }
        }
      },
      capabilityGaps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["capabilityName", "reason"],
          properties: {
            capabilityName: { type: "string" },
            reason: { type: "string" },
            existingPromptId: { type: "string" }
          }
        }
      },
      canGenerate: { type: "boolean" },
      blockingIssues: { type: "array", items: { type: "string" } }
    }
  }
};

const completePrdGenerationTool = {
  type: "function",
  name: "complete_prd_generation",
  description: "Return either generated PRD Requirement Details Markdown or the blocking input questions required by the existing PRD Base Prompt.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["result", "openQuestions", "generationNotes"],
    properties: {
      result: { type: "string", enum: ["GENERATED", "NEEDS_INPUT"] },
      requirementDetailsMarkdown: { type: "string" },
      openQuestions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question", "impact", "scope"],
          properties: {
            question: { type: "string" },
            impact: { type: "string" },
            sourcePath: { type: "string" },
            scope: {
              type: "string",
              enum: ["PRODUCT_DECISION", "ARTIFACT_DETAIL"],
              description: "Use PRODUCT_DECISION only when different answers materially change product scope, permissions, the business state machine, the core flow, or a key business rule. Use ARTIFACT_DETAIL for page/field presentation, components, labels, copy, ordinary navigation, visual states, and other artifact expression details. When uncertain, use ARTIFACT_DETAIL."
            }
          }
        }
      },
      generationNotes: { type: "array", items: { type: "string" } }
    }
  }
};

const completeInteractionGenerationTool = {
  type: "function",
  name: "complete_interaction_generation",
  description: "Return either generated Interaction Specification Markdown or the blocking questions required by the existing Interaction Design Prompt.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["result", "openQuestions", "generationNotes"],
    properties: {
      result: { type: "string", enum: ["GENERATED", "NEEDS_INPUT"] },
      interactionSpecificationMarkdown: { type: "string" },
      openQuestions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question", "impact", "scope"],
          properties: {
            question: { type: "string" },
            impact: { type: "string" },
            sourcePath: { type: "string" },
            scope: {
              type: "string",
              enum: ["PRODUCT_DECISION", "ARTIFACT_DETAIL"],
              description: "Use PRODUCT_DECISION only for material changes to scope, permissions, business states, core flow, or key business rules. Keep page/field presentation, components, labels, copy, navigation placement, and visual expression as ARTIFACT_DETAIL. When uncertain, use ARTIFACT_DETAIL."
            }
          }
        }
      },
      generationNotes: { type: "array", items: { type: "string" } }
    }
  }
};

const completeFigmaMetaAnalysisTool = {
  type: "function",
  name: "complete_figma_meta_analysis",
  description: "Return the executable Figma Prompt selection plan. Select only registry IDs; do not create Figma nodes or return the final Codex prompt.",
  strict: false,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "analysis", "selection", "capabilityGaps", "canAssemble", "blockingIssues"],
    properties: {
      schemaVersion: { type: "string", enum: ["figma-meta-plan.v1"] },
      analysis: {
        type: "object",
        additionalProperties: false,
        required: ["taskType", "pageTypes", "coreCapabilities"],
        properties: {
          taskType: { type: "string" },
          pageTypes: { type: "array", items: { type: "string" } },
          coreCapabilities: { type: "array", items: { type: "string" } }
        }
      },
      selection: {
        type: "object",
        additionalProperties: false,
        required: ["baseId", "domainCapabilityIds", "supportCapabilityIds"],
        properties: {
          baseId: { type: "string" },
          domainCapabilityIds: { type: "array", items: { type: "string" } },
          supportCapabilityIds: { type: "array", items: { type: "string" } }
        }
      },
      capabilityGaps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["capabilityName", "reason"],
          properties: {
            capabilityName: { type: "string" },
            reason: { type: "string" },
            existingPromptId: { type: "string" }
          }
        }
      },
      canAssemble: { type: "boolean" },
      blockingIssues: { type: "array", items: { type: "string" } }
    }
  }
};

export const modelTools = [
  ...atomicModelTools,
  completeDiscoveryTurnTool,
  completeSolutionTurnTool,
  completePrdMetaAnalysisTool,
  completePrdGenerationTool,
  completeInteractionGenerationTool,
  completeFigmaMetaAnalysisTool
];
