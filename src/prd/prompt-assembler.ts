import { createHash } from "node:crypto";
import type { PrdMetaPlan } from "../domain/types.js";
import { PrdPromptCatalog } from "./prompt-catalog.js";
import type { PrdSourceContext } from "./product-context.js";
import { renderCurrentProjectContext } from "./product-context.js";

export interface AssembledPrdPrompt {
  totalPrompt: string;
  totalPromptHash: string;
  selectedPromptIds: string[];
  promptHashes: Record<string, string>;
}

export async function assemblePrdPrompt(
  catalog: PrdPromptCatalog,
  plan: PrdMetaPlan,
  context: PrdSourceContext
): Promise<AssembledPrdPrompt> {
  const prompts = await catalog.orderedSelection(plan.selection);
  const sections = prompts.map(prompt => [
    `<!-- PRD_PROMPT_START ${prompt.entry.id} -->`,
    prompt.content.trim(),
    `<!-- PRD_PROMPT_END ${prompt.entry.id} -->`
  ].join("\n"));
  sections.push(renderCurrentProjectContext(context));
  const totalPrompt = sections.join("\n\n");
  return {
    totalPrompt,
    totalPromptHash: createHash("sha256").update(totalPrompt).digest("hex"),
    selectedPromptIds: prompts.map(prompt => prompt.entry.id),
    promptHashes: Object.fromEntries(prompts.map(prompt => [prompt.entry.id, prompt.hash]))
  };
}

