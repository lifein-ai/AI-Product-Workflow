export interface ModelCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface ModelResponse {
  text: string;
  calls: ModelCall[];
  historyItems: unknown[];
  observability?: {
    model: string;
    reasoningEffort: string;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    reasoningTokens: number | null;
    firstTokenTime: string | null;
    ttftMs: number | null;
    retryCount: number;
    finishReason: string | null;
  };
}

export type AIProviderProgress =
  | { phase: "PROVIDER_ATTEMPT"; attempt: number; maxAttempts: number; streaming: boolean }
  | { phase: "PROVIDER_RETRY"; attempt: number; maxAttempts: number; reason: string }
  | { phase: "PROVIDER_RESPONSE"; attempt: number; outputTokens: number | null; toolCallCount: number };

export interface AIProviderRequest {
  instructions: string;
  input: unknown[];
  toolNames: string[];
  idempotencyKey?: string;
  maxRetries?: number;
  timeoutMs?: number;
  onProgress?: (event: AIProviderProgress) => void;
}

export interface AIProvider {
  generate(request: AIProviderRequest): Promise<ModelResponse>;
}
