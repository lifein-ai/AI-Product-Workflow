import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider, ModelResponse } from "../src/ai/provider.js";
import { runGenerationCallWithRepair } from "../src/generation/generation-call.js";

function response(argumentsValue: string, callId: string): ModelResponse {
  return {
    text: "",
    calls: [{ callId, name: "complete_generation", arguments: argumentsValue }],
    historyItems: [{ type: "function_call", call_id: callId, name: "complete_generation", arguments: argumentsValue }]
  };
}

test("Generation performs at most one controlled schema repair", async () => {
  const requests: Parameters<AIProvider["generate"]>[0][] = [];
  const ai: AIProvider = {
    async generate(request) {
      requests.push(request);
      return requests.length === 1
        ? response('{"result":"GENERATED"}', "invalid-call")
        : response('{"result":"GENERATED","content":"valid"}', "repaired-call");
    }
  };

  const result = await runGenerationCallWithRepair({
    ai,
    instructions: "Generate",
    input: [{ role: "user", content: "confirmed facts" }],
    toolName: "complete_generation",
    parse(value) {
      const candidate = value as { result?: string; content?: string };
      if (candidate.result !== "GENERATED" || !candidate.content) throw new Error("content is required");
      return candidate;
    }
  });

  assert.equal(result.content, "valid");
  assert.equal(requests.length, 2);
  assert.ok(requests[1].input.some(item => {
    const candidate = item as { type?: string; output?: string };
    return candidate.type === "function_call_output" && candidate.output?.includes("content is required");
  }));
});

test("Generation stops after the single repair attempt", async () => {
  let calls = 0;
  const ai: AIProvider = {
    async generate() {
      calls += 1;
      return response("{}", `call-${calls}`);
    }
  };

  await assert.rejects(() => runGenerationCallWithRepair({
    ai,
    instructions: "Generate",
    input: [],
    toolName: "complete_generation",
    parse() { throw new Error("invalid schema"); }
  }), /Generation schema repair failed/);
  assert.equal(calls, 2);
});
