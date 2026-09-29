import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createProjectRecord, emptyFigmaPromptArtifact, emptyInteractionArtifact, emptyPrdArtifact } from "../domain/factories.js";
import type { ProjectRecord } from "../domain/types.js";
import type { ProjectRepository } from "../repositories/project-repository.js";
import type { RuntimeService } from "../runtime/runtime-service.js";
import type { PrdService } from "../prd/prd-service.js";
import type { FigmaPromptService } from "../figma/figma-prompt-service.js";
import type { InteractionService } from "../interaction/interaction-service.js";
import { confirmStage, reopenSolution } from "../workflow/state-machine.js";
import { randomUUID } from "node:crypto";
import {
  measureLatencyStep,
  measureLatencyStepSync,
  recordResponseBytes,
  withLatencyRequest
} from "../observability/latency-trace.js";
import type { RequestProgressStore } from "../runtime/request-progress.js";

export async function projectRoutes(app: FastifyInstance, deps: {
  repo: ProjectRepository;
  runtime: RuntimeService;
  prd?: PrdService;
  interaction?: InteractionService;
  figmaPrompt?: FigmaPromptService;
  requestProgress?: RequestProgressStore;
}) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid request", details: error.issues });
    if (!(error instanceof Error)) return reply.code(500).send({ error: "Internal server error" });
    if (error.message === "Project not found") return reply.code(404).send({ error: error.message });
    if (/^MODELFLARE_(API_KEY|BASE_URL|MODEL) is required/.test(error.message)) return reply.code(503).send({ error: error.message });
    if (error.message === "ModelFlare connection failed") return reply.code(502).send({ error: error.message });
    if (error.message === "ModelFlare request failed") return reply.code(502).send({ error: error.message });
    if (/^ModelFlare (temporarily unavailable|rate limited request|rejected request)/.test(error.message)) {
      return reply.code(502).send({ error: error.message });
    }
    if (error.message === "ModelFlare API compatibility error") return reply.code(502).send({ error: error.message });
    if (error.message === "ModelFlare response exceeded output token limit") return reply.code(502).send({ error: error.message });
    if (error.message.startsWith("ModelFlare response incomplete:")) return reply.code(502).send({ error: error.message });
    if (error.message === "ModelFlare request timed out") return reply.code(504).send({ error: error.message });
    if (/^Codex CLI (not found|login is invalid or expired)/.test(error.message)) return reply.code(503).send({ error: error.message });
    if (error.message.startsWith("Codex CLI request timed out")) return reply.code(504).send({ error: error.message });
    if (/^Codex (CLI exited|CLI process|CLI readiness check|CLI login status|output file|output JSON|structured output|Provider)/.test(error.message)) {
      return reply.code(502).send({ error: error.message });
    }
    if (/^(DISCOVERY|SOLUTION) turn repair failed:/.test(error.message)) {
      return reply.code(502).send({ error: "AI response failed workflow validation after one repair" });
    }
    if (/changed concurrently|not ready for confirmation|Cannot run|must be confirmed|cannot be started|no longer current|must be generated|current draft|blocking open questions|must be current and confirmed|based on stale|blocked on open questions|must be blocked|Prompt assets changed|Prompt changed|Confirmed Product State/.test(error.message)) {
      return reply.code(409).send({ error: error.message });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "Internal server error" });
  });
  app.post("/projects", async (request, reply) => {
    const input = z.object({ name: z.string().min(1), initialRequirement: z.string().min(1) }).parse(request.body);
    const project = await deps.repo.create(createProjectRecord(input.name, input.initialRequirement));
    return reply.code(201).send(project);
  });

  app.get("/requests/:requestId", async (request, reply) => {
    const { requestId } = z.object({ requestId: z.string().min(1).max(128) }).parse(request.params);
    const progress = deps.requestProgress?.get(requestId);
    if (!progress) return reply.code(404).send({ error: "Request progress not found" });
    return progress;
  });

  app.get("/projects", async () => {
    const projects = await deps.repo.list();
    const summaries = await Promise.all(projects.map(async project => ({
      id: project.id,
      name: project.productSpec.project.name,
      initialRequirement: project.productSpec.project.initialRequirement,
      createdAt: project.productSpec.project.createdAt,
      updatedAt: projectActivityAt(project),
      activeStage: project.workflow.activeStage,
      stageStatuses: Object.fromEntries(Object.entries(project.workflow.stages).map(([stage, state]) => [stage, state.status])),
      artifacts: {
        prd: artifactSummary(project.artifacts.prd),
        interaction: artifactSummary(project.artifacts.interaction),
        figmaPrompt: artifactSummary(project.artifacts.figmaPrompt)
      },
      recordVersion: project.recordVersion,
      storage: await deps.repo.storageInfo(project.id)
    })));
    return { projects: summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) };
  });

  app.patch("/projects/:id", async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(request.body);
    const project = await requireProject(deps.repo, id);
    project.productSpec.project.name = name;
    project.productSpec.project.updatedAt = new Date().toISOString();
    await deps.repo.save(project);
    return project;
  });

  app.delete("/projects/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const deleted = await deps.repo.delete(id);
    if (!deleted) return reply.code(404).send({ error: "Project not found" });
    return reply.code(204).send();
  });

  app.get("/projects/:id/export", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await requireProject(deps.repo, id);
    const safeName = project.productSpec.project.name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "project";
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}.json`)}`);
    return JSON.stringify(project, null, 2);
  });

  app.delete("/projects/:id/artifacts/prd", async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await requireProject(deps.repo, id);
    const timestamp = new Date().toISOString();
    project.artifacts.prd = emptyPrdArtifact(timestamp);
    project.artifacts.interaction = emptyInteractionArtifact(timestamp);
    project.artifacts.figmaPrompt = emptyFigmaPromptArtifact(timestamp);
    await deps.repo.save(project);
    return { project, removed: ["prd", "interaction", "figmaPrompt"] };
  });

  app.delete("/projects/:id/artifacts/interaction", async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await requireProject(deps.repo, id);
    const timestamp = new Date().toISOString();
    project.artifacts.interaction = emptyInteractionArtifact(timestamp);
    project.artifacts.figmaPrompt = emptyFigmaPromptArtifact(timestamp);
    await deps.repo.save(project);
    return { project, removed: ["interaction", "figmaPrompt"] };
  });

  app.delete("/projects/:id/artifacts/figma-prompt", async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await requireProject(deps.repo, id);
    project.artifacts.figmaPrompt = emptyFigmaPromptArtifact();
    await deps.repo.save(project);
    return { project, removed: ["figmaPrompt"] };
  });

  app.post("/projects/:id/artifacts/cleanup", async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await requireProject(deps.repo, id);
    const timestamp = new Date().toISOString();
    const removed: string[] = [];
    if (isDisposableArtifact(project.artifacts.prd)) {
      project.artifacts.prd = emptyPrdArtifact(timestamp);
      project.artifacts.interaction = emptyInteractionArtifact(timestamp);
      project.artifacts.figmaPrompt = emptyFigmaPromptArtifact(timestamp);
      removed.push("prd", "interaction", "figmaPrompt");
    } else if (isDisposableArtifact(project.artifacts.interaction)) {
      project.artifacts.interaction = emptyInteractionArtifact(timestamp);
      project.artifacts.figmaPrompt = emptyFigmaPromptArtifact(timestamp);
      removed.push("interaction", "figmaPrompt");
    } else if (isDisposableArtifact(project.artifacts.figmaPrompt)) {
      project.artifacts.figmaPrompt = emptyFigmaPromptArtifact(timestamp);
      removed.push("figmaPrompt");
    }
    if (removed.length > 0) await deps.repo.save(project);
    return { project, removed };
  });

  app.get("/projects/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await deps.repo.getById(id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    return project;
  });

  app.post("/projects/:id/messages", async (request, reply) => {
    const suppliedRequestId = request.headers["x-request-id"];
    const requestId = typeof suppliedRequestId === "string" && suppliedRequestId.length <= 128 ? suppliedRequestId : randomUUID();
    reply.header("x-request-id", requestId);
    return withLatencyRequest(requestId, async () => {
      const { id } = measureLatencyStepSync("request_params_validation", () => z.object({ id: z.string() }).parse(request.params));
      request.log.info({ request_id: requestId, project_id: id }, "Stage Message Request");
      const { content } = measureLatencyStepSync("request_body_validation", () => z.object({ content: z.string().min(1) }).parse(request.body));
      const result = await measureLatencyStep("runtime_send_message", () => deps.runtime.sendMessage(id, content, requestId));
      measureLatencyStepSync("response_prepare", () => recordResponseBytes(Buffer.byteLength(JSON.stringify(result), "utf8")));
      return result;
    });
  });

  app.post("/projects/:id/stages/discovery/confirm", async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await deps.repo.getById(id);
    if (!project) throw new Error("Project not found");
    confirmStage(project, "DISCOVERY");
    await deps.repo.save(project);
    return project.workflow;
  });

  app.post("/projects/:id/stages/solution/start", async (request, reply) => {
    const suppliedRequestId = request.headers["x-request-id"];
    const requestId = typeof suppliedRequestId === "string" && suppliedRequestId.length <= 128 ? suppliedRequestId : randomUUID();
    reply.header("x-request-id", requestId);
    return withLatencyRequest(requestId, async () => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      request.log.info({ request_id: requestId, project_id: id }, "Start Solution");
      return deps.runtime.startSolution(id, requestId);
    });
  });

  app.post("/projects/:id/stages/solution/confirm", async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await deps.repo.getById(id);
    if (!project) throw new Error("Project not found");
    confirmStage(project, "SOLUTION");
    await deps.repo.save(project);
    return project.workflow;
  });

  app.post("/projects/:id/stages/solution/reopen", async request => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const project = await deps.repo.getById(id);
    if (!project) throw new Error("Project not found");
    reopenSolution(project);
    await deps.repo.save(project);
    return { project };
  });

  app.post("/projects/:id/artifacts/prd/generate", async request => {
    if (!deps.prd) throw new Error("PRD service is not configured");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return deps.prd.generate(id);
  });

  app.patch("/projects/:id/artifacts/prd", async request => {
    if (!deps.prd) throw new Error("PRD service is not configured");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { content } = z.object({ content: z.string().trim().min(1) }).parse(request.body);
    return deps.prd.update(id, content);
  });

  app.post("/projects/:id/artifacts/prd/clarify", async request => {
    if (!deps.prd) throw new Error("PRD service is not configured");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { answer } = z.object({ answer: z.string().trim().min(1) }).parse(request.body);
    return deps.prd.clarifyAndGenerate(id, answer);
  });

  app.post("/projects/:id/artifacts/prd/confirm", async request => {
    if (!deps.prd) throw new Error("PRD service is not configured");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return deps.prd.confirm(id);
  });

  app.post("/projects/:id/artifacts/interaction/generate", async request => {
    if (!deps.interaction) throw new Error("Interaction service is not configured");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return deps.interaction.generate(id);
  });

  app.post("/projects/:id/artifacts/interaction/clarify", async request => {
    if (!deps.interaction) throw new Error("Interaction service is not configured");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { answer } = z.object({ answer: z.string().trim().min(1) }).parse(request.body);
    return deps.interaction.clarifyAndGenerate(id, answer);
  });

  app.patch("/projects/:id/artifacts/interaction", async request => {
    if (!deps.interaction) throw new Error("Interaction service is not configured");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { content } = z.object({ content: z.string().trim().min(1) }).parse(request.body);
    return deps.interaction.update(id, content);
  });

  app.post("/projects/:id/artifacts/interaction/confirm", async request => {
    if (!deps.interaction) throw new Error("Interaction service is not configured");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return deps.interaction.confirm(id);
  });

  app.post("/projects/:id/artifacts/figma-prompt/generate", async request => {
    if (!deps.figmaPrompt) throw new Error("Figma Prompt service is not configured");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return deps.figmaPrompt.generate(id);
  });

  app.patch("/projects/:id/artifacts/figma-prompt", async request => {
    if (!deps.figmaPrompt) throw new Error("Figma Prompt service is not configured");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { content } = z.object({ content: z.string().trim().min(1) }).parse(request.body);
    return deps.figmaPrompt.update(id, content);
  });

  app.post("/projects/:id/artifacts/figma-prompt/confirm", async request => {
    if (!deps.figmaPrompt) throw new Error("Figma Prompt service is not configured");
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return deps.figmaPrompt.confirm(id);
  });
}

async function requireProject(repo: ProjectRepository, id: string) {
  const project = await repo.getById(id);
  if (!project) throw new Error("Project not found");
  return project;
}

function artifactSummary(artifact: ProjectRecord["artifacts"][keyof ProjectRecord["artifacts"]]) {
  return {
    lifecycleStatus: artifact.lifecycleStatus,
    reviewStatus: artifact.reviewStatus,
    contentRevision: artifact.contentRevision,
    updatedAt: artifact.updatedAt,
    bytes: Buffer.byteLength(artifact.currentContent ?? "", "utf8")
  };
}

function projectActivityAt(project: ProjectRecord) {
  return [
    project.productSpec.project.updatedAt,
    project.productSpec.version.updatedAt,
    ...Object.values(project.workflow.stages).map(stage => stage.updatedAt),
    project.artifacts.prd.updatedAt,
    project.artifacts.interaction.updatedAt,
    project.artifacts.figmaPrompt.updatedAt,
    ...project.messages.map(message => message.createdAt)
  ].filter(Boolean).sort().at(-1) ?? project.productSpec.project.createdAt;
}

function isDisposableArtifact(artifact: ProjectRecord["artifacts"][keyof ProjectRecord["artifacts"]]) {
  return artifact.lifecycleStatus === "STALE" || artifact.lifecycleStatus === "FAILED" || artifact.reviewStatus === "BLOCKED";
}
