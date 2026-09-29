import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { Response as OpenAIResponse, ResponseInputItem, Tool } from "openai/resources/responses/responses";
import type { AIProvider, AIProviderRequest, ModelResponse } from "./provider.js";
import { modelTools } from "../tools/definitions.js";

export class OpenAIProvider implements AIProvider {
  private client?: OpenAI;
  private readonly apiKey?: string;
  private readonly baseURL?: string;
  private readonly model: string;
  private readonly streaming: boolean;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    streaming?: boolean;
    timeoutMs?: number;
    maxRetries?: number;
  }) {
    this.apiKey = options?.apiKey ?? process.env.MODELFLARE_API_KEY ?? process.env.OPENAI_API_KEY;
    this.baseURL = options?.baseURL ?? process.env.MODELFLARE_BASE_URL ?? process.env.OPENAI_BASE_URL;
    this.model = options?.model ?? process.env.MODELFLARE_MODEL ?? process.env.OPENAI_MODEL ?? "";
    // Some OpenAI-compatible relays accept short Responses streams but terminate
    // longer tool-call streams. Keep streaming opt-in until the configured relay
    // is known to preserve long-lived SSE connections reliably.
    this.streaming = options?.streaming ?? process.env.MODELFLARE_STREAMING === "1";
    this.timeoutMs = options?.timeoutMs ?? readBoundedInteger("MODELFLARE_TIMEOUT_MS", 240_000, 10_000, 600_000);
    this.maxRetries = options?.maxRetries ?? readBoundedInteger("MODELFLARE_MAX_RETRIES", 1, 0, 2);
  }

  async generate(request: AIProviderRequest): Promise<ModelResponse> {
    if (!this.apiKey) throw new Error("MODELFLARE_API_KEY is required for AI generation");
    if (!this.baseURL) throw new Error("MODELFLARE_BASE_URL is required for AI generation");
    if (!this.model) throw new Error("MODELFLARE_MODEL is required for AI generation");
    this.client ??= new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      timeout: this.timeoutMs,
      maxRetries: 0
    });
    const selectedTools = modelTools.filter(tool => request.toolNames.includes(tool.name)) as Tool[];
    const forcedTurnTool = selectedTools.length === 1 && request.toolNames[0]?.startsWith("complete_")
      ? request.toolNames[0]
      : undefined;
    const toolChoice = forcedTurnTool
      ? { type: "function" as const, name: forcedTurnTool }
      : "auto" as const;
    const body = {
      model: this.model,
      instructions: request.instructions,
      input: request.input as ResponseInputItem[],
      ...(selectedTools.length ? { tools: selectedTools, tool_choice: toolChoice } : {}),
      max_output_tokens: Number(process.env.MODELFLARE_MAX_OUTPUT_TOKENS ?? 8_192),
      store: false
    };
    const timeout = request.timeoutMs ?? this.timeoutMs;
    const maxRetries = request.maxRetries ?? this.maxRetries;
    const maxAttempts = maxRetries + 1;
    let response: OpenAIResponse | undefined;
    let retryCount = 0;
    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      const attempt = attemptIndex + 1;
      request.onProgress?.({ phase: "PROVIDER_ATTEMPT", attempt, maxAttempts, streaming: this.streaming });
      try {
        const requestOptions = {
          timeout,
          maxRetries: 0,
          ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {})
        };
        response = this.streaming
          ? await this.client.responses.stream(body, requestOptions).finalResponse()
          : await this.client.responses.create(body, requestOptions);
        if (response.status === "incomplete") {
          const reason = response.incomplete_details?.reason ?? "unknown";
          if (reason === "max_output_tokens") throw new Error("ModelFlare response exceeded output token limit");
          throw new Error(`ModelFlare response incomplete: ${reason}`);
        }
        request.onProgress?.({
          phase: "PROVIDER_RESPONSE",
          attempt,
          outputTokens: response.usage?.output_tokens ?? null,
          toolCallCount: response.output.filter(item => item.type === "function_call").length
        });
        break;
      } catch (error) {
        if (attemptIndex < maxRetries && isSafeRetryableProviderError(error)) {
          retryCount += 1;
          request.onProgress?.({
            phase: "PROVIDER_RETRY",
            attempt: attempt + 1,
            maxAttempts,
            reason: providerErrorKind(error)
          });
          continue;
        }
        throw mapProviderError(error);
      }
    }
    if (!response) throw new Error("ModelFlare request failed without a response");
    return {
      text: response.output_text || "",
      calls: response.output.filter(item => item.type === "function_call").map(call => ({
        callId: call.call_id, name: call.name, arguments: call.arguments
      })),
      historyItems: toResponseInputItems(response.output),
      observability: {
        model: response.model || this.model,
        reasoningEffort: "unspecified",
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? null,
        reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? null,
        firstTokenTime: null,
        ttftMs: null,
        retryCount,
        finishReason: response.error
          ? `error:${response.error.code}`
          : response.incomplete_details?.reason ?? response.status ?? null
      }
    };
  }
}

function isSafeRetryableProviderError(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof OpenAI.APIConnectionError) return true;
  if (error instanceof OpenAI.BadRequestError && error.param === "stream_options.include_usage") return true;
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    return [408, 409, 425, 429].includes(status) || status >= 500;
  }
  return isTransportLikeError(error);
}

function mapProviderError(error: unknown): Error {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new Error("ModelFlare request timed out", { cause: error });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new Error("ModelFlare connection failed", { cause: error });
  }
  if (error instanceof OpenAI.BadRequestError && error.param === "stream_options.include_usage") {
    return new Error("ModelFlare API compatibility error", { cause: error });
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    if (status === 429) return new Error("ModelFlare rate limited request", { cause: error });
    if ([408, 409, 425].includes(status) || status >= 500) {
      return new Error(`ModelFlare temporarily unavailable (HTTP ${status || "unknown"})`, { cause: error });
    }
    return new Error(`ModelFlare rejected request (HTTP ${status || "unknown"})`, { cause: error });
  }
  if (isTransportLikeError(error)) return new Error("ModelFlare connection failed", { cause: error });
  return new Error("ModelFlare request failed", { cause: error });
}

function providerErrorKind(error: unknown): string {
  if (error instanceof OpenAI.APIConnectionTimeoutError) return "timeout";
  if (error instanceof OpenAI.APIConnectionError) return "connection";
  if (error instanceof OpenAI.APIError) return `http_${error.status ?? "unknown"}`;
  if (isTransportLikeError(error)) return "transport";
  return "provider_error";
}

function isTransportLikeError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) {
      const name = current.name.toLowerCase();
      const message = current.message.toLowerCase();
      if (
        name.includes("connection") ||
        name.includes("abort") ||
        message.includes("fetch failed") ||
        message.includes("connection") ||
        message.includes("socket") ||
        message.includes("stream") ||
        message.includes("premature close") ||
        message.includes("terminated")
      ) return true;
      current = current.cause;
      continue;
    }
    if (typeof current === "object" && current !== null && "cause" in current) {
      current = current.cause;
      continue;
    }
    break;
  }
  return false;
}

function readBoundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}
