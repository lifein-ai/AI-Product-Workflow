import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AIProvider, ModelResponse } from "../ai/provider.js";
import type { InteractionArtifactState, ProjectRecord } from "../domain/types.js";
import { normalizeGenerationQuestions, routeProductDecisionQuestions } from "../generation/question-router.js";
import { GENERATION_QUESTION_SCOPE_GUIDANCE } from "../generation/question-router.js";
import { runGenerationCallWithRepair } from "../generation/generation-call.js";
import type { ProjectRepository } from "../repositories/project-repository.js";
import { requireConfirmedProductState } from "../workflow/confirmed-product-state.js";
import { invalidateFigmaPromptArtifact } from "../workflow/state-machine.js";
import { buildInteractionSourceContext, renderInteractionContext } from "./product-context.js";
import { interactionGenerationResultSchema } from "./schemas.js";

const now = () => new Date().toISOString();
const defaultPromptPath = resolve(process.cwd(), "data", "03 AI Prompt库", "3.1 PRD Prompt体系", "Interaction Design Prompt V2.md");

export class InteractionService {
  constructor(
    private readonly repo: ProjectRepository,
    private readonly ai: AIProvider,
    private readonly promptPath = defaultPromptPath
  ) {}

  async generate(projectId: string): Promise<{ artifact: InteractionArtifactState; project: ProjectRecord }> {
    const project = await this.loadProject(projectId);
    if (project.artifacts.interaction.lifecycleStatus === "CURRENT") {
      throw new Error("Current Interaction Specification must be cleared before generating a replacement");
    }
    const context = buildInteractionSourceContext(project);
    const prompt = await readFile(this.promptPath, "utf8");
    const generation = normalizeGenerationQuestions(await this.runGeneration(prompt, context));
    const timestamp = now();
    const shared = {
      contentRevision: project.artifacts.interaction.contentRevision + 1,
      sourceVersions: context.sourceVersions,
      promptHash: createHash("sha256").update(prompt).digest("hex"),
      openQuestions: generation.openQuestions,
      clarifications: [],
      generationNotes: generation.generationNotes,
      updatedAt: timestamp
    };
    project.artifacts.interaction = generation.result === "GENERATED"
      ? {
          ...shared,
          lifecycleStatus: "CURRENT",
          reviewStatus: "DRAFT",
          generatedContent: generation.interactionSpecificationMarkdown!.trim(),
          currentContent: generation.interactionSpecificationMarkdown!.trim(),
          blockingIssues: [],
          generatedAt: timestamp
        }
      : {
          ...shared,
          lifecycleStatus: "NOT_GENERATED",
          reviewStatus: "BLOCKED",
          blockingIssues: generation.openQuestions.map(question => question.question)
        };
    invalidateFigmaPromptArtifact(project);
    if (generation.result === "NEEDS_INPUT") routeProductDecisionQuestions(project, generation.openQuestions, "INTERACTION");
    await this.repo.save(project);
    return { artifact: project.artifacts.interaction, project };
  }

  async clarifyAndGenerate(projectId: string, answer: string): Promise<{ artifact: InteractionArtifactState; project: ProjectRecord }> {
    const project = await this.loadProject(projectId);
    const artifact = project.artifacts.interaction;
    assertCurrentSource(project, artifact);
    if (
      artifact.lifecycleStatus !== "NOT_GENERATED" || artifact.reviewStatus !== "BLOCKED" ||
      artifact.openQuestions.length === 0 || artifact.openQuestions.some(question => question.scope === "PRODUCT_DECISION")
    ) throw new Error("Interaction Specification must be blocked on artifact questions before clarification can continue");
    const context = buildInteractionSourceContext(project);
    const prompt = await readFile(this.promptPath, "utf8");
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    if (artifact.promptHash !== promptHash) throw new Error("Interaction Prompt changed; regenerate before continuing clarification");
    const clarifications = [...artifact.clarifications, {
      questions: structuredClone(artifact.openQuestions),
      answer: answer.trim(),
      answeredAt: now()
    }];
    const generation = normalizeGenerationQuestions(await this.runGeneration(prompt, context, clarifications));
    const timestamp = now();
    const shared = {
      contentRevision: artifact.contentRevision + 1,
      sourceVersions: context.sourceVersions,
      promptHash,
      openQuestions: generation.openQuestions,
      clarifications,
      generationNotes: generation.generationNotes,
      updatedAt: timestamp
    };
    project.artifacts.interaction = generation.result === "GENERATED"
      ? {
          ...shared,
          lifecycleStatus: "CURRENT",
          reviewStatus: "DRAFT",
          generatedContent: generation.interactionSpecificationMarkdown!.trim(),
          currentContent: generation.interactionSpecificationMarkdown!.trim(),
          blockingIssues: [],
          generatedAt: timestamp
        }
      : {
          ...shared,
          lifecycleStatus: "NOT_GENERATED",
          reviewStatus: "BLOCKED",
          blockingIssues: generation.openQuestions.map(question => question.question)
        };
    invalidateFigmaPromptArtifact(project);
    if (generation.result === "NEEDS_INPUT") routeProductDecisionQuestions(project, generation.openQuestions, "INTERACTION");
    await this.repo.save(project);
    return { artifact: project.artifacts.interaction, project };
  }

  async update(projectId: string, content: string) {
    const project = await this.loadProject(projectId);
    const artifact = project.artifacts.interaction;
    assertCurrentSource(project, artifact);
    if (artifact.lifecycleStatus !== "CURRENT" || !artifact.generatedContent) throw new Error("Interaction Specification must be generated and current before it can be edited");
    artifact.currentContent = content.trim();
    artifact.contentRevision += 1;
    artifact.reviewStatus = "DRAFT";
    artifact.confirmedAt = undefined;
    artifact.updatedAt = now();
    invalidateFigmaPromptArtifact(project);
    await this.repo.save(project);
    return { artifact, project };
  }

  async confirm(projectId: string) {
    const project = await this.loadProject(projectId);
    const artifact = project.artifacts.interaction;
    assertCurrentSource(project, artifact);
    if (artifact.lifecycleStatus !== "CURRENT" || artifact.reviewStatus !== "DRAFT" || !artifact.currentContent?.trim()) {
      throw new Error("Interaction Specification must be a non-empty current draft before confirmation");
    }
    artifact.reviewStatus = "CONFIRMED";
    artifact.confirmedAt = now();
    artifact.updatedAt = artifact.confirmedAt;
    await this.repo.save(project);
    return { artifact, project };
  }

  private async runGeneration(
    prompt: string,
    context: ReturnType<typeof buildInteractionSourceContext>,
    clarifications: InteractionArtifactState["clarifications"] = []
  ) {
    const sections = [
      prompt.trim(),
      renderInteractionContext(context),
      clarifications.length > 0 ? `# Human Clarifications\n\n${JSON.stringify(clarifications, null, 2)}` : "",
      "# Runtime Output Contract",
      `Return exactly one complete_interaction_generation call. Put only the Interaction Specification Markdown in interactionSpecificationMarkdown. If critical input is missing, return NEEDS_INPUT. ${GENERATION_QUESTION_SCOPE_GUIDANCE}`
    ].filter(Boolean);
    return runGenerationCallWithRepair({
      ai: this.ai,
      instructions: sections.join("\n\n"),
      input: [{ role: "user", content: clarifications.length === 0
        ? "Generate the Interaction Specification from the confirmed workflow context."
        : "Continue generating the Interaction Specification using the saved human clarifications." }],
      toolName: "complete_interaction_generation",
      parse: value => interactionGenerationResultSchema.parse(value)
    });
  }

  private async loadProject(projectId: string) {
    const project = await this.repo.getById(projectId);
    if (!project) throw new Error("Project not found");
    return project;
  }
}

function assertCurrentSource(project: ProjectRecord, artifact: InteractionArtifactState): void {
  if (!artifact.sourceVersions) throw new Error("Interaction Specification has no source version snapshot");
  const prd = project.artifacts.prd;
  if (
    prd.lifecycleStatus !== "CURRENT" || prd.reviewStatus !== "CONFIRMED" ||
    prd.contentRevision !== artifact.sourceVersions.prd || artifact.lifecycleStatus === "STALE"
  ) throw new Error("Interaction Specification source PRD is no longer current");
  const state = requireConfirmedProductState(project);
  if (state.contentHash !== artifact.sourceVersions.confirmedProductStateHash) {
    throw new Error("Interaction Specification source Product State is no longer current");
  }
}
