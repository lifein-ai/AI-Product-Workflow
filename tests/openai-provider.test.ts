import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { OpenAIProvider } from "../src/ai/openai-provider.js";

test("Provider retries one transient connection timeout and reports it once", async () => {
  const provider = new OpenAIProvider({ apiKey: "test", baseURL: "https://invalid.local", model: "test-model", streaming: false });
  let attempts = 0;
  const client = {
    responses: {
      async create() {
        attempts += 1;
        if (attempts === 1) throw new OpenAI.APIConnectionTimeoutError({ message: "timed out" });
        return {
          status: "completed",
          output: [],
          output_text: "ok",
          model: "test-model",
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 }
          },
          error: null,
          incomplete_details: null
        };
      }
    }
  };
  Object.assign(provider, { client });

  const result = await provider.generate({ instructions: "test", input: [], toolNames: [] });
  assert.equal(attempts, 2);
  assert.equal(result.text, "ok");
  assert.equal(result.observability?.retryCount, 1);
});

test("Provider does not retry a non-transient validation error", async () => {
  const provider = new OpenAIProvider({ apiKey: "test", baseURL: "https://invalid.local", model: "test-model", streaming: false });
  let attempts = 0;
  const error = new OpenAI.BadRequestError(400, { message: "invalid schema", param: "tools" }, "invalid schema", new Headers());
  Object.assign(provider, {
    client: { responses: { async create() { attempts += 1; throw error; } } }
  });

  await assert.rejects(() => provider.generate({ instructions: "test", input: [], toolNames: [] }), /rejected request \(HTTP 400\)/);
  assert.equal(attempts, 1);
});

test("Provider assembles a streaming response and reports progress", async () => {
  const provider = new OpenAIProvider({ apiKey: "test", baseURL: "https://invalid.local", model: "test-model", streaming: true });
  const events: string[] = [];
  Object.assign(provider, {
    client: {
      responses: {
        stream() {
          return {
            async finalResponse() {
              return {
                status: "completed",
                output: [],
                output_text: "ok",
                model: "test-model",
                usage: {
                  input_tokens: 10,
                  output_tokens: 2,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 }
                },
                error: null,
                incomplete_details: null
              };
            }
          };
        }
      }
    }
  });

  const result = await provider.generate({
    instructions: "test",
    input: [],
    toolNames: [],
    onProgress: event => events.push(event.phase)
  });

  assert.equal(result.text, "ok");
  assert.deepEqual(events, ["PROVIDER_ATTEMPT", "PROVIDER_RESPONSE"]);
});

test("Provider retries a relay HTTP 500 once", async () => {
  const provider = new OpenAIProvider({ apiKey: "test", baseURL: "https://invalid.local", model: "test-model", streaming: false });
  let attempts = 0;
  const client = {
    responses: {
      async create() {
        attempts += 1;
        if (attempts === 1) throw new OpenAI.InternalServerError(500, { message: "temporarily unavailable" }, "temporarily unavailable", new Headers());
        return {
          status: "completed",
          output: [],
          output_text: "ok",
          model: "test-model",
          usage: null,
          error: null,
          incomplete_details: null
        };
      }
    }
  };
  Object.assign(provider, { client });

  const result = await provider.generate({ instructions: "test", input: [], toolNames: [] });
  assert.equal(result.text, "ok");
  assert.equal(attempts, 2);
});

test("Provider maps a terminated response stream to a retryable connection failure", async () => {
  const provider = new OpenAIProvider({
    apiKey: "test",
    baseURL: "https://invalid.local",
    model: "test-model",
    streaming: true,
    maxRetries: 0
  });
  Object.assign(provider, {
    client: {
      responses: {
        stream() {
          return {
            async finalResponse() {
              throw new Error("response stream terminated before completion");
            }
          };
        }
      }
    }
  });

  await assert.rejects(
    () => provider.generate({ instructions: "test", input: [], toolNames: [] }),
    /ModelFlare connection failed/
  );
});
