import type { AIProvider, ModelResponse } from "../ai/provider.js";
import type { PrdArtifactState, PrdMetaPlan, ProjectRecord } from "../domain/types.js";
import type { ProjectRepository } from "../repositories/project-repository.js";
import { assemblePrdPrompt } from "./prompt-assembler.js";
import { PrdPromptCatalog } from "./prompt-catalog.js";
import { buildPrdSourceContext } from "./product-context.js";
import { prdGenerationResultSchema, prdMetaPlanSchema } from "./schemas.js";
import { invalidateInteractionArtifact } from "../workflow/state-machine.js";
import { requireConfirmedProductState } from "../workflow/confirmed-product-state.js";
import { runGenerationCallWithRepair } from "../generation/generation-call.js";
import { GENERATION_QUESTION_SCOPE_GUIDANCE, normalizeGenerationQuestions, routeProductDecisionQuestions } from "../generation/question-router.js";
import { buildPrdMetaContext } from "./product-context.js";

const now = () => new Date().toISOString();

export class PrdService {
  constructor(
    private readonly repo: ProjectRepository,
    private readonly ai: AIProvider,
    private readonly catalog = new PrdPromptCatalog()
  ) {}

  async generate(projectId: string): Promise<{ artifact: PrdArtifactState; project: ProjectRecord }> {
    const project = await this.loadProject(projectId);
    const sourceContext = buildPrdSourceContext(project);
    const plan = normalizeMetaPlan(await this.runMetaAnalysis(sourceContext));
    const selectedIds = selectionIds(plan);
    const contentRevision = project.artifacts.prd.contentRevision + 1;

    if (!plan.canGenerate || plan.capabilityGaps.length > 0 || plan.blockingIssues.length > 0) {
      project.artifacts.prd = {
        contentRevision,
        lifecycleStatus: "NOT_GENERATED",
        reviewStatus: "BLOCKED",
        sourceVersions: sourceContext.sourceVersions,
        metaPlan: plan,
        selectedPromptIds: selectedIds,
        promptHashes: {},
        openQuestions: [],
        clarifications: [],
        generationNotes: [],
        blockingIssues: [
          ...plan.blockingIssues,
          ...plan.capabilityGaps.map(gap => `${gap.capabilityName}: ${gap.reason}`)
        ],
        updatedAt: now()
      };
      invalidateInteractionArtifact(project);
      await this.repo.save(project);
      return { artifact: project.artifacts.prd, project };
    }

    await this.catalog.validateSelection(plan.selection);
    const assembled = await assemblePrdPrompt(this.catalog, plan, sourceContext);
    const generation = normalizeGenerationQuestions(await this.runGeneration(assembled.totalPrompt));

    const timestamp = now();
    project.artifacts.prd = generation.result === "GENERATED"
      ? {
          contentRevision,
          lifecycleStatus: "CURRENT",
          reviewStatus: "DRAFT",
          sourceVersions: sourceContext.sourceVersions,
          metaPlan: plan,
          selectedPromptIds: assembled.selectedPromptIds,
          promptHashes: assembled.promptHashes,
          totalPromptHash: assembled.totalPromptHash,
          generatedContent: generation.requirementDetailsMarkdown!.trim(),
          currentContent: generation.requirementDetailsMarkdown!.trim(),
          openQuestions: generation.openQuestions,
          clarifications: [],
          generationNotes: generation.generationNotes,
          blockingIssues: [],
          generatedAt: timestamp,
          updatedAt: timestamp
        }
      : {
          contentRevision,
          lifecycleStatus: "NOT_GENERATED",
          reviewStatus: "BLOCKED",
          sourceVersions: sourceContext.sourceVersions,
          metaPlan: plan,
          selectedPromptIds: assembled.selectedPromptIds,
          promptHashes: assembled.promptHashes,
          totalPromptHash: assembled.totalPromptHash,
          openQuestions: generation.openQuestions,
          clarifications: [],
          generationNotes: generation.generationNotes,
          blockingIssues: generation.openQuestions.map(question => question.question),
          updatedAt: timestamp
        };
    invalidateInteractionArtifact(project);
    if (generation.result === "NEEDS_INPUT") routeProductDecisionQuestions(project, generation.openQuestions, "PRD");
    await this.repo.save(project);
    return { artifact: project.artifacts.prd, project };
  }

  async clarifyAndGenerate(projectId: string, answer: string): Promise<{ artifact: PrdArtifactState; project: ProjectRecord }> {
    const project = await this.loadProject(projectId);
    const artifact = project.artifacts.prd;
    assertCurrentArtifactSource(project, artifact);
    if (
      artifact.lifecycleStatus !== "NOT_GENERATED" ||
      artifact.reviewStatus !== "BLOCKED" ||
      artifact.openQuestions.length === 0 ||
      !artifact.metaPlan ||
      !artifact.totalPromptHash ||
      artifact.openQuestions.some(question => question.scope === "PRODUCT_DECISION")
    ) {
      throw new Error("PRD must be blocked on open questions before clarification can continue");
    }

    const sourceContext = buildPrdSourceContext(project);
    await this.catalog.validateSelection(artifact.metaPlan.selection);
    const assembled = await assemblePrdPrompt(this.catalog, artifact.metaPlan, sourceContext);
    if (assembled.totalPromptHash !== artifact.totalPromptHash) {
      throw new Error("PRD Prompt assets changed; regenerate PRD before continuing clarification");
    }

    const clarification = {
      questions: structuredClone(artifact.openQuestions),
      answer: answer.trim(),
      answeredAt: now()
    };
    const clarifications = [...artifact.clarifications, clarification];
    const generation = normalizeGenerationQuestions(await this.runGeneration(assembled.totalPrompt, clarifications));
    const timestamp = now();
    const shared = {
      contentRevision: artifact.contentRevision + 1,
      sourceVersions: sourceContext.sourceVersions,
      metaPlan: artifact.metaPlan,
      selectedPromptIds: assembled.selectedPromptIds,
      promptHashes: assembled.promptHashes,
      totalPromptHash: assembled.totalPromptHash,
      clarifications,
      generationNotes: generation.generationNotes,
      updatedAt: timestamp
    };
    project.artifacts.prd = generation.result === "GENERATED"
      ? {
          ...shared,
          lifecycleStatus: "CURRENT",
          reviewStatus: "DRAFT",
          generatedContent: generation.requirementDetailsMarkdown!.trim(),
          currentContent: generation.requirementDetailsMarkdown!.trim(),
          openQuestions: generation.openQuestions,
          blockingIssues: [],
          generatedAt: timestamp
        }
      : {
          ...shared,
          lifecycleStatus: "NOT_GENERATED",
          reviewStatus: "BLOCKED",
          openQuestions: generation.openQuestions,
          blockingIssues: generation.openQuestions.map(question => question.question)
        };
    invalidateInteractionArtifact(project);
    if (generation.result === "NEEDS_INPUT") routeProductDecisionQuestions(project, generation.openQuestions, "PRD");
    await this.repo.save(project);
    return { artifact: project.artifacts.prd, project };
  }

  async update(projectId: string, content: string): Promise<{ artifact: PrdArtifactState; project: ProjectRecord }> {
    const project = await this.loadProject(projectId);
    const artifact = project.artifacts.prd;
    assertCurrentArtifactSource(project, artifact);
    if (artifact.lifecycleStatus !== "CURRENT" || !artifact.generatedContent) {
      throw new Error("PRD must be generated and current before it can be edited");
    }
    artifact.currentContent = content.trim();
    artifact.contentRevision += 1;
    artifact.reviewStatus = "DRAFT";
    artifact.confirmedAt = undefined;
    artifact.updatedAt = now();
    invalidateInteractionArtifact(project);
    await this.repo.save(project);
    return { artifact, project };
  }

  async confirm(projectId: string): Promise<{ artifact: PrdArtifactState; project: ProjectRecord }> {
    const project = await this.loadProject(projectId);
    const artifact = project.artifacts.prd;
    assertCurrentArtifactSource(project, artifact);
    if (artifact.lifecycleStatus !== "CURRENT" || artifact.reviewStatus !== "DRAFT" || !artifact.currentContent?.trim()) {
      throw new Error("PRD must be a non-empty current draft before confirmation");
    }
    artifact.reviewStatus = "CONFIRMED";
    artifact.confirmedAt = now();
    artifact.updatedAt = artifact.confirmedAt;
    await this.repo.save(project);
    return { artifact, project };
  }

  private async runMetaAnalysis(sourceContext: ReturnType<typeof buildPrdSourceContext>): Promise<PrdMetaPlan> {
    const constraint = await this.catalog.readPrompt("prd.constraint.prompt-generation");
    const meta = await this.catalog.readPrompt("prd.meta");
    const humanRegistry = await this.catalog.humanRegistry();
    const registryView = await this.catalog.metaRegistryView();
    const instructions = [
      constraint.content.trim(),
      meta.content.trim(),
      "# Runtime PRD Prompt Registry",
      humanRegistry.trim(),
      "# Machine Registry IDs",
      JSON.stringify(registryView, null, 2),
      "# Prompt Selection Context",
      "This is a deterministic, compact projection used only for Prompt and Capability selection. Full confirmed business content is supplied later to Generation.",
      JSON.stringify(buildPrdMetaContext(sourceContext), null, 2),
      "# Runtime Output Contract",
      "Return exactly one complete_prd_meta_analysis call. Use only machine Registry IDs. Do not generate PRD text or Prompt contents. The deterministic Confirmed Product State supplied as Current Project Context is the executable Project Layer for this project; the absence of a reusable library Project Prompt is not a capability gap and must not block generation. ProjectPromptIds must remain empty unless the machine Registry marks an exact matching Project Prompt selectable. If a Draft or missing reusable Capability is required, report it in capabilityGaps and set canGenerate=false."
    ].join("\n\n");
    return prdMetaPlanSchema.parse(parseSingleCall(
      await this.ai.generate({
        instructions,
        input: [{ role: "user", content: "Analyze the confirmed Product Solution and return the executable PRD Prompt plan." }],
        toolNames: ["complete_prd_meta_analysis"]
      }),
      "complete_prd_meta_analysis"
    ));
  }

  private async runGeneration(totalPrompt: string, clarifications: PrdArtifactState["clarifications"] = []) {
    const clarificationSection = clarifications.length === 0 ? "" : [
      "# Human Clarifications",
      "These answers were supplied by the human reviewer for blocking questions raised during PRD generation. Treat them as confirmed input for those questions and do not ask the same question again unless the answer is contradictory or incomplete.",
      JSON.stringify(clarifications, null, 2)
    ].join("\n\n");
    const instructions = [
      totalPrompt,
      clarificationSection,
      "# Runtime Output Contract",
      `Return exactly one complete_prd_generation call. Put only the PRD Requirement Details Markdown in requirementDetailsMarkdown. If the existing PRD Base Prompt requires blocking clarification, return NEEDS_INPUT and list only those questions. ${GENERATION_QUESTION_SCOPE_GUIDANCE}`
    ].filter(Boolean).join("\n\n");
    return runGenerationCallWithRepair({
      ai: this.ai,
      instructions,
      input: [{
          role: "user",
          content: clarifications.length === 0
            ? "Generate the PRD Requirement Details from the confirmed Current Project Context."
            : "Continue generating the PRD Requirement Details using the saved human clarifications."
        }],
      toolName: "complete_prd_generation",
      parse: value => prdGenerationResultSchema.parse(value)
    });
  }

  private async loadProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.repo.getById(projectId);
    if (!project) throw new Error("Project not found");
    return project;
  }
}

function normalizeMetaPlan(plan: PrdMetaPlan): PrdMetaPlan {
  if (plan.capabilityGaps.length > 0 || plan.blockingIssues.length === 0) return plan;
  const allExplicitlyNonBlocking = plan.blockingIssues.every(issue =>
    /(?:不|无需)(?:会|应)?阻止.{0,40}(?:生成|产出)\s*PRD|(?:does|should)\s+not\s+block.{0,40}(?:PRD\s+)?generation/iu.test(issue)
  );
  if (!allExplicitlyNonBlocking) return plan;
  return { ...plan, canGenerate: true, blockingIssues: [] };
}

function parseSingleCall(response: ModelResponse, expectedName: string): unknown {
  if (response.calls.length !== 1 || response.calls[0].name !== expectedName) {
    throw new Error(`Expected exactly one ${expectedName} call; received ${response.calls.map(call => call.name).join(", ") || "none"}`);
  }
  return JSON.parse(response.calls[0].arguments);
}

function selectionIds(plan: PrdMetaPlan): string[] {
  return [
    plan.selection.baseId,
    ...plan.selection.domainCapabilityIds,
    ...plan.selection.generalCapabilityIds,
    ...plan.selection.supportCapabilityIds,
    ...plan.selection.projectPromptIds
  ];
}

function assertCurrentArtifactSource(project: ProjectRecord, artifact: PrdArtifactState): void {
  if (!artifact.sourceVersions) throw new Error("PRD has no source version snapshot");
  const discovery = project.workflow.stages.DISCOVERY;
  const solution = project.workflow.stages.SOLUTION;
  if (
    discovery.status !== "CONFIRMED" ||
    solution.status !== "CONFIRMED" ||
    discovery.confirmedVersion !== artifact.sourceVersions.discovery ||
    solution.confirmedVersion !== artifact.sourceVersions.solution ||
    artifact.lifecycleStatus === "STALE"
  ) {
    throw new Error("PRD source Product Solution is no longer current");
  }
  const confirmedProductState = requireConfirmedProductState(project);
  if (
    (artifact.sourceVersions.confirmedProductStateVersion !== undefined &&
      confirmedProductState.stateVersion !== artifact.sourceVersions.confirmedProductStateVersion) ||
    (artifact.sourceVersions.confirmedProductStateHash !== undefined &&
      confirmedProductState.contentHash !== artifact.sourceVersions.confirmedProductStateHash)
  ) throw new Error("PRD source Product Solution is no longer current");
}
