import type { AIProvider, ModelResponse } from "../ai/provider.js";

interface GenerationCallOptions<T> {
  ai: AIProvider;
  instructions: string;
  input: unknown[];
  toolName: string;
  parse: (value: unknown) => T;
}

export async function runGenerationCallWithRepair<T>(options: GenerationCallOptions<T>): Promise<T> {
  const first = await options.ai.generate({
    instructions: options.instructions,
    input: options.input,
    toolNames: [options.toolName]
  });
  try {
    return parseGenerationResponse(first, options.toolName, options.parse);
  } catch (error) {
    const repairInput = [...options.input, ...first.historyItems];
    const message = error instanceof Error ? error.message : String(error);
    if (first.calls.length > 0) {
      for (const call of first.calls) {
        repairInput.push({
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify({ success: false, error: message })
        });
      }
    } else {
      repairInput.push({
        role: "user",
        content: `The generation response failed the required schema: ${message}. Return one corrected ${options.toolName} call without changing confirmed business facts.`
      });
    }
    const repaired = await options.ai.generate({
      instructions: options.instructions,
      input: repairInput,
      toolNames: [options.toolName]
    });
    try {
      return parseGenerationResponse(repaired, options.toolName, options.parse);
    } catch (repairError) {
      throw new Error(`Generation schema repair failed: ${repairError instanceof Error ? repairError.message : String(repairError)}`, { cause: repairError });
    }
  }
}

function parseGenerationResponse<T>(response: ModelResponse, expectedName: string, parse: (value: unknown) => T): T {
  if (response.calls.length !== 1 || response.calls[0].name !== expectedName) {
    throw new Error(`Expected exactly one ${expectedName} call; received ${response.calls.map(call => call.name).join(", ") || "none"}`);
  }
  return parse(JSON.parse(response.calls[0].arguments));
}
