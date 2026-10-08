import { randomUUID } from "node:crypto";
import type { ProjectRepository } from "../repositories/project-repository.js";
import type { AIProvider } from "../ai/provider.js";
import { runToolLoop } from "./tool-loop.js";
import { measureLatencyStep, measureLatencyStepSync } from "../observability/latency-trace.js";
import { startStage } from "../workflow/state-machine.js";
import { RequestProgressStore } from "./request-progress.js";
import { SOLUTION_KICKOFF } from "./stage-messages.js";

export class RuntimeService {
  constructor(
    private readonly repo: ProjectRepository,
    private readonly ai: AIProvider,
    private readonly progress: RequestProgressStore = new RequestProgressStore()
  ) {}

  async sendMessage(projectId: string, content: string, requestId?: string) {
    if (requestId) this.progress.start(requestId, projectId);
    try {
      const project = await measureLatencyStep("repository_read", () => this.repo.getById(projectId));
      if (!project) throw new Error("Project not found");

      // The current user message is passed to the model directly. Historical messages
      // in the project are context only, so the current message is not duplicated.
      const stage = project.workflow.activeStage;
      if (!stage) throw new Error("No active stage");
      const userMessageId = randomUUID();
      const userMessageCreatedAt = new Date().toISOString();
      const reply = await measureLatencyStep("tool_loop_total", () => runToolLoop(project, content, this.ai, requestId, {
        type: "USER_MESSAGE",
        messageId: userMessageId,
        ...(requestId ? { requestId } : {})
      }, this.reporter(requestId)));
      this.progress.update(requestId, "SAVING", "The response passed validation; saving the project update.");
      measureLatencyStepSync("append_messages", () => {
        project.messages.push({ id: userMessageId, role: "user", content, createdAt: userMessageCreatedAt, stage });
        project.messages.push({ id: randomUUID(), role: "assistant", content: reply, createdAt: new Date().toISOString(), stage });
      });
      await measureLatencyStep("repository_save", () => this.repo.save(project));
      this.progress.update(requestId, "COMPLETED", "The response and structured project update were saved.");
      return { reply, project };
    } catch (error) {
      this.progress.update(requestId, "FAILED", safeFailureDetail(error));
      throw error;
    }
  }

  async startSolution(projectId: string, requestId?: string) {
    if (requestId) this.progress.start(requestId, projectId);
    try {
      const project = await measureLatencyStep("repository_read", () => this.repo.getById(projectId));
      if (!project) throw new Error("Project not found");
      startStage(project, "SOLUTION");
      const reply = await measureLatencyStep("tool_loop_total", () => runToolLoop(project, SOLUTION_KICKOFF, this.ai, requestId, {
        type: "SYSTEM",
        ...(requestId ? { requestId } : {})
      }, this.reporter(requestId)));
      this.progress.update(requestId, "SAVING", "The response passed validation; saving the Product Solution update.");
      measureLatencyStepSync("append_messages", () => {
        project.messages.push({ id: randomUUID(), role: "assistant", content: reply, createdAt: new Date().toISOString(), stage: "SOLUTION" });
      });
      await measureLatencyStep("repository_save", () => this.repo.save(project));
      this.progress.update(requestId, "COMPLETED", "The Product Solution response was saved.");
      return { reply, project };
    } catch (error) {
      this.progress.update(requestId, "FAILED", safeFailureDetail(error));
      throw error;
    }
  }

  private reporter(requestId?: string) {
    return {
      onPhase: (phase: Parameters<RequestProgressStore["update"]>[1], detail: string) => this.progress.update(requestId, phase, detail),
      onProviderProgress: (event: Parameters<RequestProgressStore["providerEvent"]>[1]) => this.progress.providerEvent(requestId, event)
    };
  }
}

function safeFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/repair failed/i.test(message)) return "ModelFlare returned output, but the repair also failed local workflow validation. Nothing was saved.";
  if (/timed out/i.test(message)) return "ModelFlare timed out after the configured attempts. Nothing was saved.";
  if (/temporarily unavailable|rate limited|connection failed/i.test(message)) return "ModelFlare was unavailable after the configured attempts. Nothing was saved.";
  return "The request failed before the project update could be saved.";
}
