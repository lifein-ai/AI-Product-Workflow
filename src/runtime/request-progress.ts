import type { AIProviderProgress } from "../ai/provider.js";

export type RequestPhase =
  | "STARTED"
  | "PROVIDER_CALL"
  | "PROVIDER_RETRY"
  | "VALIDATING_RESPONSE"
  | "REPAIRING_RESPONSE"
  | "SAVING"
  | "COMPLETED"
  | "FAILED";

export interface RequestProgress {
  requestId: string;
  projectId: string;
  phase: RequestPhase;
  detail: string;
  startedAt: string;
  updatedAt: string;
  completed: boolean;
}

export class RequestProgressStore {
  private readonly entries = new Map<string, RequestProgress>();

  start(requestId: string, projectId: string): void {
    const now = new Date().toISOString();
    this.prune();
    this.entries.set(requestId, {
      requestId,
      projectId,
      phase: "STARTED",
      detail: "Preparing the workflow context.",
      startedAt: now,
      updatedAt: now,
      completed: false
    });
  }

  update(requestId: string | undefined, phase: RequestPhase, detail: string): void {
    if (!requestId) return;
    const current = this.entries.get(requestId);
    if (!current) return;
    this.entries.set(requestId, {
      ...current,
      phase,
      detail,
      updatedAt: new Date().toISOString(),
      completed: phase === "COMPLETED" || phase === "FAILED"
    });
  }

  providerEvent(requestId: string | undefined, event: AIProviderProgress): void {
    if (event.phase === "PROVIDER_ATTEMPT") {
      this.update(
        requestId,
        "PROVIDER_CALL",
        `Calling AI provider (${event.attempt}/${event.maxAttempts}, ${event.streaming ? "streaming" : "non-streaming"}).`
      );
      return;
    }
    if (event.phase === "PROVIDER_RETRY") {
      this.update(requestId, "PROVIDER_RETRY", `AI provider attempt failed; retrying (${event.attempt}/${event.maxAttempts}).`);
      return;
    }
    this.update(
      requestId,
      "VALIDATING_RESPONSE",
      `AI provider returned ${event.outputTokens ?? "unknown"} output tokens and ${event.toolCallCount} tool call(s); validating locally.`
    );
  }

  get(requestId: string): RequestProgress | undefined {
    this.prune();
    return this.entries.get(requestId);
  }

  private prune(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [requestId, entry] of this.entries) {
      if (Date.parse(entry.updatedAt) < cutoff) this.entries.delete(requestId);
    }
  }
}
