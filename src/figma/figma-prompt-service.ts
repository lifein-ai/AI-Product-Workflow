import type { AIProvider, ModelResponse } from "../ai/provider.js";
import type { FigmaMetaPlan, FigmaPromptArtifactState, ProjectRecord } from "../domain/types.js";
import type { ProjectRepository } from "../repositories/project-repository.js";
import { assembleCodexFigmaPrompt } from "./prompt-assembler.js";
import { FigmaPromptCatalog } from "./prompt-catalog.js";
import { buildFigmaMetaContext, buildFigmaSourceContext } from "./product-context.js";
import { figmaMetaPlanSchema } from "./schemas.js";
import { requireConfirmedProductState } from "../workflow/confirmed-product-state.js";

const now = () => new Date().toISOString();

export class FigmaPromptService {
  constructor(
    private readonly repo: ProjectRepository,
    private readonly ai: AIProvider,
    private readonly catalog = new FigmaPromptCatalog()
  ) {}

  async generate(projectId: string): Promise<{ artifact: FigmaPromptArtifactState; project: ProjectRecord }> {
    const project = await this.loadProject(projectId);
    const sourceContext = buildFigmaSourceContext(project);
    const plan = await this.runMetaAnalysis(sourceContext);
    const selectedIds = [plan.selection.baseId, ...plan.selection.domainCapabilityIds, ...plan.selection.supportCapabilityIds];
    const contentRevision = project.artifacts.figmaPrompt.contentRevision + 1;
    if (!plan.canAssemble || plan.capabilityGaps.length > 0 || plan.blockingIssues.length > 0) {
      project.artifacts.figmaPrompt = {
        contentRevision,
        lifecycleStatus: "NOT_GENERATED",
        reviewStatus: "BLOCKED",
        sourceVersions: sourceContext.sourceVersions,
        metaPlan: plan,
        selectedPromptIds: selectedIds,
        promptHashes: {},
        blockingIssues: [
          ...plan.blockingIssues,
          ...plan.capabilityGaps.map(gap => `${gap.capabilityName}: ${gap.reason}`)
        ],
        updatedAt: now()
      };
      await this.repo.save(project);
      return { artifact: project.artifacts.figmaPrompt, project };
    }

    await this.catalog.validateSelection(plan.selection);
    const assembled = await assembleCodexFigmaPrompt(this.catalog, plan, sourceContext);
    const timestamp = now();
    project.artifacts.figmaPrompt = {
      contentRevision,
      lifecycleStatus: "CURRENT",
      reviewStatus: "DRAFT",
      sourceVersions: sourceContext.sourceVersions,
      metaPlan: plan,
      selectedPromptIds: assembled.selectedPromptIds,
      promptHashes: assembled.promptHashes,
      totalPromptHash: assembled.totalPromptHash,
      generatedContent: assembled.totalPrompt,
      currentContent: assembled.totalPrompt,
      blockingIssues: [],
      generatedAt: timestamp,
      updatedAt: timestamp
    };
    await this.repo.save(project);
    return { artifact: project.artifacts.figmaPrompt, project };
  }

  async update(projectId: string, content: string): Promise<{ artifact: FigmaPromptArtifactState; project: ProjectRecord }> {
    const project = await this.loadProject(projectId);
    const artifact = project.artifacts.figmaPrompt;
    assertCurrentSource(project, artifact);
    if (artifact.lifecycleStatus !== "CURRENT" || !artifact.generatedContent) throw new Error("Figma Prompt must be generated and current before it can be edited");
    artifact.currentContent = content.trim();
    artifact.contentRevision += 1;
    artifact.reviewStatus = "DRAFT";
    artifact.confirmedAt = undefined;
    artifact.updatedAt = now();
    await this.repo.save(project);
    return { artifact, project };
  }

  async confirm(projectId: string): Promise<{ artifact: FigmaPromptArtifactState; project: ProjectRecord }> {
    const project = await this.loadProject(projectId);
    const artifact = project.artifacts.figmaPrompt;
    assertCurrentSource(project, artifact);
    if (artifact.lifecycleStatus !== "CURRENT" || artifact.reviewStatus !== "DRAFT" || !artifact.currentContent?.trim()) {
      throw new Error("Figma Prompt must be a non-empty current draft before confirmation");
    }
    artifact.reviewStatus = "CONFIRMED";
    artifact.confirmedAt = now();
    artifact.updatedAt = artifact.confirmedAt;
    await this.repo.save(project);
    return { artifact, project };
  }

  private async runMetaAnalysis(sourceContext: ReturnType<typeof buildFigmaSourceContext>): Promise<FigmaMetaPlan> {
    const constraint = await this.catalog.readPrompt("figma.constraint.prompt-generation");
    const meta = await this.catalog.readPrompt("figma.meta");
    const instructions = [
      constraint.content.trim(),
      meta.content.trim(),
      "# Human Figma Prompt Registry",
      (await this.catalog.humanRegistry()).trim(),
      "# Machine Registry IDs",
      JSON.stringify(await this.catalog.metaRegistryView(), null, 2),
      "# Reusable Asset Registry",
      (await this.catalog.reusableAssetRegistry()).trim(),
      "# Prompt Selection Context",
      "This is a deterministic, compact projection used only for Figma Prompt capability selection. The final deterministic Assembly receives the complete confirmed PRD, Interaction Specification, and Product State.",
      JSON.stringify(buildFigmaMetaContext(sourceContext), null, 2),
      "# Runtime Output Contract",
      "Return exactly one complete_figma_meta_analysis call. Use only machine Registry IDs. Do not create a Project Prompt, do not generate Figma nodes, and do not write the final Codex prompt. The program will deterministically project the confirmed workflow context and assemble the final prompt. If a Draft or missing Capability is required, report it in capabilityGaps and set canAssemble=false."
    ].join("\n\n");
    return figmaMetaPlanSchema.parse(parseSingleCall(
      await this.ai.generate({
        instructions,
        input: [{ role: "user", content: "Analyze the confirmed Product State, PRD, and Interaction Specification, then return the executable Figma Prompt selection plan." }],
        toolNames: ["complete_figma_meta_analysis"]
      }),
      "complete_figma_meta_analysis"
    ));
  }

  private async loadProject(projectId: string): Promise<ProjectRecord> {
    const project = await this.repo.getById(projectId);
    if (!project) throw new Error("Project not found");
    return project;
  }
}

function parseSingleCall(response: ModelResponse, expectedName: string): unknown {
  if (response.calls.length !== 1 || response.calls[0].name !== expectedName) {
    throw new Error(`Expected exactly one ${expectedName} call; received ${response.calls.map(call => call.name).join(", ") || "none"}`);
  }
  return JSON.parse(response.calls[0].arguments);
}

function assertCurrentSource(project: ProjectRecord, artifact: FigmaPromptArtifactState): void {
  if (!artifact.sourceVersions) throw new Error("Figma Prompt has no source version snapshot");
  const discovery = project.workflow.stages.DISCOVERY;
  const solution = project.workflow.stages.SOLUTION;
  const prd = project.artifacts.prd;
  const interaction = project.artifacts.interaction;
  if (
    discovery.status !== "CONFIRMED" ||
    solution.status !== "CONFIRMED" ||
    prd.lifecycleStatus !== "CURRENT" ||
    prd.reviewStatus !== "CONFIRMED" ||
    interaction.lifecycleStatus !== "CURRENT" ||
    interaction.reviewStatus !== "CONFIRMED" ||
    discovery.confirmedVersion !== artifact.sourceVersions.discovery ||
    solution.confirmedVersion !== artifact.sourceVersions.solution ||
    prd.contentRevision !== artifact.sourceVersions.prd ||
    interaction.contentRevision !== artifact.sourceVersions.interaction ||
    artifact.lifecycleStatus === "STALE"
  ) {
    throw new Error("Figma Prompt source PRD is no longer current");
  }
  const confirmedProductState = requireConfirmedProductState(project);
  if (
    (artifact.sourceVersions.confirmedProductStateVersion !== undefined &&
      confirmedProductState.stateVersion !== artifact.sourceVersions.confirmedProductStateVersion) ||
    (artifact.sourceVersions.confirmedProductStateHash !== undefined &&
      confirmedProductState.contentHash !== artifact.sourceVersions.confirmedProductStateHash)
  ) throw new Error("Figma Prompt source PRD is no longer current");
}
