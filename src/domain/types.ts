export type ReasoningStage = "DISCOVERY" | "SOLUTION" | "INTERACTION";

export type StageStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "READY_FOR_CONFIRMATION"
  | "CONFIRMED"
  | "NEEDS_REVIEW"
  | "BLOCKED";

export type CriterionStatus =
  | "SUFFICIENT"
  | "PARTIAL"
  | "MISSING"
  | "NOT_APPLICABLE";

export interface Actor {
  id: string;
  name: string;
  description?: string;
}

export interface Scenario {
  id: string;
  actorId: string;
  trigger?: string;
  context: string;
  goal: string;
  currentProblem?: string;
}

export interface Constraint {
  id: string;
  type: "BUSINESS" | "TECHNICAL" | "RESOURCE" | "VERSION" | "COMPLIANCE" | "OTHER";
  description: string;
}

export interface Hypothesis {
  id: string;
  statement: string;
  rationale?: string;
}

export type BehaviorChangeBasis =
  | {
      type: "EVIDENCED_FRICTION";
      friction: string;
      evidence: string[];
    }
  | {
      type: "ACCEPTED_ASSUMPTION";
      assumption: string;
      evidenceStatus: "LIMITED" | "UNVALIDATED";
      decisionId: string;
      validationIntent: string;
    };

export interface BehaviorChangeDefinition {
  targetBehavior: string;
  basis: BehaviorChangeBasis;
}

export interface DiscoverySpec {
  background?: {
    requirementSource?: string;
    whyNow?: string;
    context?: string;
  };
  problem?: {
    statement: string;
    impact?: string[];
  };
  users: {
    primary: Actor[];
    related: Actor[];
  };
  scenarios: Scenario[];
  goals: {
    primary?: string;
    secondary: string[];
  };
  behaviorChange?: BehaviorChangeDefinition;
  currentProduct: {
    capabilities: string[];
    currentFlow?: string;
    reusableCapabilities: string[];
    limitations: string[];
    problems: string[];
  };
  direction?: {
    summary: string;
    rationale: string[];
  };
  constraints: Constraint[];
  scope: {
    mustSolve: string[];
    canDefer: string[];
    outOfScope: string[];
  };
  hypotheses: Hypothesis[];
}

export interface SolutionMechanism {
  id: string;
  name: string;
  description: string;
}

export interface SolutionRule {
  id: string;
  rule: string;
  rationale?: string;
}

export interface ProductFlowStep {
  id: string;
  step: string;
  actor?: string;
  outcome?: string;
}

export interface SolutionTradeOff {
  id: string;
  topic: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
}

export interface SolutionRisk {
  id: string;
  risk: string;
  mitigation?: string;
}

export interface SolutionAssumption {
  id: string;
  assumption: string;
  validationIntent?: string;
}

export interface SolutionSpec {
  summary?: string;
  coreSolution?: string;
  keyMechanisms: SolutionMechanism[];
  scope: {
    inScope: string[];
    outOfScope: string[];
  };
  keyRules: SolutionRule[];
  mainProductFlow: ProductFlowStep[];
  tradeOffs: SolutionTradeOff[];
  risks: SolutionRisk[];
  assumptions: SolutionAssumption[];
}

export interface ProductSpec {
  project: {
    id: string;
    name: string;
    initialRequirement: string;
    createdAt: string;
    updatedAt: string;
  };
  discovery: DiscoverySpec;
  solution: SolutionSpec;
  interaction: Record<string, unknown>;
  openQuestions: OpenQuestion[];
  decisions: Decision[];
  version: {
    schemaVersion: "0.1";
    revision: number;
    updatedAt: string;
  };
}

export type ResolutionMethod =
  | "DERIVE"
  | "DEFAULT"
  | "RESEARCH"
  | "DATA_VALIDATION"
  | "STAKEHOLDER_CONFIRMATION"
  | "TECHNICAL_VALIDATION"
  | "PRODUCT_DECISION"
  | "DEFER";

export interface OpenQuestion {
  id: string;
  createdInStage: ReasoningStage;
  ownerStage: ReasoningStage;
  question: string;
  impact: string;
  blocking: boolean;
  resolutionMethod: ResolutionMethod;
  status: "OPEN" | "RESOLVED" | "DEFERRED";
  resolution?: string;
  source?: {
    type: "STAGE" | "GENERATION" | "LEGACY";
    artifact?: "PRD" | "INTERACTION" | "FIGMA_PROMPT";
    sourcePath?: string;
  };
  validation?: {
    type: "RESEARCH" | "DATA" | "STAKEHOLDER" | "TECHNICAL";
    expectedOutput?: string;
    relatedOpenQuestionId?: string;
  };
}

export interface Decision {
  id: string;
  projectId?: string;
  stage: ReasoningStage;
  feature?: string;
  topic?: string;
  decision: string;
  rationale: string[];
  reason?: string | null;
  alternatives?: DecisionAlternative[];
  importance?: 1 | 2 | 3;
  strength?: "EXPLICIT" | "IMPLIED" | "TENTATIVE";
  sourceMessageIds?: string[];
  history?: DecisionHistoryEntry[];
  affectedPaths: string[];
  status: "ACTIVE" | "SUPERSEDED" | "DEFERRED";
  source?: {
    type: "INITIAL_REQUIREMENT" | "USER_MESSAGE" | "VALIDATION_RESULT" | "DECISION_EXTRACTION" | "SYSTEM" | "LEGACY";
    messageId?: string;
    requestId?: string;
  };
  createdAt?: string;
  updatedAt?: string;
  supersedesDecisionId?: string;
  supersededBy?: string;
}

export interface DecisionAlternative {
  option: string;
  rejectionReason: string | null;
}

export interface DecisionHistoryEntry {
  action: "CREATED" | "UPDATED" | "SUPERSEDED";
  at: string;
  decision: string;
  reason: string | null;
  sourceMessageIds: string[];
}

export interface DecisionMemoryState {
  lastScannedMessageId?: string;
  lastScannedAt?: string;
  lastAttemptAt?: string;
  status: "IDLE" | "PENDING" | "FAILED";
  pendingMessageCount?: number;
  lastError?: string;
}

export interface ConfirmedProductState {
  schemaVersion: "confirmed-product-state.v1";
  stateVersion: number;
  lifecycleStatus: "CURRENT" | "STALE";
  sourceVersions: {
    discovery: number;
    solution: number;
    productSpecRevision: number;
  };
  project: Pick<ProductSpec["project"], "id" | "initialRequirement">;
  discovery: DiscoverySpec;
  solution: SolutionSpec;
  activeDecisions: Decision[];
  relevantOpenQuestions: OpenQuestion[];
  evidenceAndAssumptions: {
    evidence: Array<{ sourcePath: string; value: unknown }>;
    assumptions: Array<{ sourcePath: string; value: unknown }>;
    validationIntents: Array<{ sourcePath: string; value: unknown }>;
  };
  confirmedAt: string;
  contentHash: string;
}

export interface StageCriterionEvaluation {
  criterionId: string;
  status: CriterionStatus;
  reason: string;
}

export interface ReadyEvaluation {
  criteria: StageCriterionEvaluation[];
  blockingUnknownIds: string[];
  result: "READY" | "NOT_READY";
  summary: string;
  evaluatedContentVersion: number;
  dependencySnapshot: Partial<Record<ReasoningStage, number>>;
}

export interface StageRuntimeState {
  status: StageStatus;
  contentVersion: number;
  confirmedVersion?: number;
  readyEvaluation?: ReadyEvaluation;
  dependencySnapshot?: Partial<Record<ReasoningStage, number>>;
  blockingIssues: string[];
  updatedAt: string;
}

export interface WorkflowState {
  activeStage: ReasoningStage | null;
  stages: Record<ReasoningStage, StageRuntimeState>;
}

export type ArtifactLifecycleStatus = "NOT_GENERATED" | "CURRENT" | "STALE" | "FAILED";
export type ArtifactReviewStatus = "NOT_STARTED" | "DRAFT" | "BLOCKED" | "CONFIRMED";

export interface PrdPromptSelection {
  baseId: string;
  domainCapabilityIds: string[];
  generalCapabilityIds: string[];
  supportCapabilityIds: string[];
  projectPromptIds: string[];
}

export interface PrdCapabilityGap {
  capabilityName: string;
  reason: string;
  existingPromptId?: string;
}

export interface PrdMetaPlan {
  schemaVersion: "prd-meta-plan.v1";
  analysis: {
    requirementType: string;
    domains: string[];
    coreObjects: string[];
    roles: string[];
    goal: string;
  };
  selection: PrdPromptSelection;
  capabilityGaps: PrdCapabilityGap[];
  canGenerate: boolean;
  blockingIssues: string[];
}

export interface PrdGenerationQuestion {
  question: string;
  impact: string;
  sourcePath?: string;
  scope?: "PRODUCT_DECISION" | "ARTIFACT_DETAIL";
}

export interface PrdClarification {
  questions: PrdGenerationQuestion[];
  answer: string;
  answeredAt: string;
}

export interface PrdArtifactState {
  contentRevision: number;
  lifecycleStatus: ArtifactLifecycleStatus;
  reviewStatus: ArtifactReviewStatus;
  sourceVersions?: {
    discovery: number;
    solution: number;
    productSpecRevision: number;
    confirmedProductStateVersion?: number;
    confirmedProductStateHash?: string;
  };
  metaPlan?: PrdMetaPlan;
  selectedPromptIds: string[];
  promptHashes: Record<string, string>;
  totalPromptHash?: string;
  generatedContent?: string;
  currentContent?: string;
  openQuestions: PrdGenerationQuestion[];
  clarifications: PrdClarification[];
  generationNotes: string[];
  blockingIssues: string[];
  generatedAt?: string;
  updatedAt: string;
  confirmedAt?: string;
}

export interface InteractionArtifactState {
  contentRevision: number;
  lifecycleStatus: ArtifactLifecycleStatus;
  reviewStatus: ArtifactReviewStatus;
  sourceVersions?: {
    discovery: number;
    solution: number;
    productSpecRevision: number;
    confirmedProductStateVersion: number;
    confirmedProductStateHash: string;
    prd: number;
  };
  promptHash?: string;
  generatedContent?: string;
  currentContent?: string;
  openQuestions: PrdGenerationQuestion[];
  clarifications: PrdClarification[];
  generationNotes: string[];
  blockingIssues: string[];
  generatedAt?: string;
  updatedAt: string;
  confirmedAt?: string;
}

export interface FigmaPromptSelection {
  baseId: string;
  domainCapabilityIds: string[];
  supportCapabilityIds: string[];
}

export interface FigmaCapabilityGap {
  capabilityName: string;
  reason: string;
  existingPromptId?: string;
}

export interface FigmaMetaPlan {
  schemaVersion: "figma-meta-plan.v1";
  analysis: {
    taskType: string;
    pageTypes: string[];
    coreCapabilities: string[];
  };
  selection: FigmaPromptSelection;
  capabilityGaps: FigmaCapabilityGap[];
  canAssemble: boolean;
  blockingIssues: string[];
}

export interface FigmaPromptArtifactState {
  contentRevision: number;
  lifecycleStatus: ArtifactLifecycleStatus;
  reviewStatus: ArtifactReviewStatus;
  sourceVersions?: {
    discovery: number;
    solution: number;
    prd: number;
    interaction?: number;
    confirmedProductStateVersion?: number;
    confirmedProductStateHash?: string;
  };
  metaPlan?: FigmaMetaPlan;
  selectedPromptIds: string[];
  promptHashes: Record<string, string>;
  totalPromptHash?: string;
  generatedContent?: string;
  currentContent?: string;
  blockingIssues: string[];
  generatedAt?: string;
  updatedAt: string;
  confirmedAt?: string;
}

export interface ProjectArtifacts {
  prd: PrdArtifactState;
  interaction: InteractionArtifactState;
  figmaPrompt: FigmaPromptArtifactState;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  stage?: ReasoningStage;
}

export interface ProjectRecord {
  id: string;
  recordVersion: number;
  productSpec: ProductSpec;
  confirmedProductState?: ConfirmedProductState;
  workflow: WorkflowState;
  artifacts: ProjectArtifacts;
  messages: ConversationMessage[];
  decisionMemory: DecisionMemoryState;
}
