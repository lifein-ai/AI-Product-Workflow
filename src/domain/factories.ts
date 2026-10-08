import { randomUUID } from "node:crypto";
import type {
  DiscoverySpec,
  FigmaPromptArtifactState,
  InteractionArtifactState,
  PrdArtifactState,
  ProductSpec,
  ProjectRecord,
  SolutionSpec,
  StageRuntimeState,
  WorkflowState
} from "./types.js";

const now = () => new Date().toISOString();

export function emptyPrdArtifact(timestamp = now()): PrdArtifactState {
  return {
    contentRevision: 0,
    lifecycleStatus: "NOT_GENERATED",
    reviewStatus: "NOT_STARTED",
    selectedPromptIds: [],
    promptHashes: {},
    openQuestions: [],
    clarifications: [],
    generationNotes: [],
    blockingIssues: [],
    updatedAt: timestamp
  };
}

export function emptyFigmaPromptArtifact(timestamp = now()): FigmaPromptArtifactState {
  return {
    contentRevision: 0,
    lifecycleStatus: "NOT_GENERATED",
    reviewStatus: "NOT_STARTED",
    selectedPromptIds: [],
    promptHashes: {},
    blockingIssues: [],
    updatedAt: timestamp
  };
}

export function emptyInteractionArtifact(timestamp = now()): InteractionArtifactState {
  return {
    contentRevision: 0,
    lifecycleStatus: "NOT_GENERATED",
    reviewStatus: "NOT_STARTED",
    openQuestions: [],
    clarifications: [],
    generationNotes: [],
    blockingIssues: [],
    updatedAt: timestamp
  };
}

export function emptyDiscovery(): DiscoverySpec {
  return {
    users: { primary: [], related: [] },
    scenarios: [],
    goals: { secondary: [] },
    currentProduct: {
      capabilities: [],
      reusableCapabilities: [],
      limitations: [],
      problems: []
    },
    constraints: [],
    scope: { mustSolve: [], canDefer: [], outOfScope: [] },
    hypotheses: []
  };
}

export function emptySolution(): SolutionSpec {
  return {
    keyMechanisms: [],
    scope: { inScope: [], outOfScope: [] },
    keyRules: [],
    mainProductFlow: [],
    tradeOffs: [],
    risks: [],
    assumptions: []
  };
}

function stageState(status: StageRuntimeState["status"]): StageRuntimeState {
  return {
    status,
    contentVersion: 0,
    blockingIssues: [],
    updatedAt: now()
  };
}

export function createProjectRecord(name: string, initialRequirement: string): ProjectRecord {
  const id = randomUUID();
  const timestamp = now();
  const productSpec: ProductSpec = {
    project: { id, name, initialRequirement, createdAt: timestamp, updatedAt: timestamp },
    discovery: emptyDiscovery(),
    solution: emptySolution(),
    interaction: {},
    openQuestions: [],
    decisions: [],
    version: { schemaVersion: "0.1", revision: 0, updatedAt: timestamp }
  };
  const workflow: WorkflowState = {
    activeStage: "DISCOVERY",
    stages: {
      DISCOVERY: stageState("IN_PROGRESS"),
      SOLUTION: stageState("NOT_STARTED"),
      INTERACTION: stageState("NOT_STARTED")
    }
  };
  return {
    id,
    recordVersion: 0,
    productSpec,
    workflow,
    artifacts: {
      prd: emptyPrdArtifact(timestamp),
      interaction: emptyInteractionArtifact(timestamp),
      figmaPrompt: emptyFigmaPromptArtifact(timestamp)
    },
    messages: [],
    decisionMemory: { status: "IDLE" }
  };
}
