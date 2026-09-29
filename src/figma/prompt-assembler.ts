import { createHash } from "node:crypto";
import type { FigmaMetaPlan } from "../domain/types.js";
import { FigmaPromptCatalog } from "./prompt-catalog.js";
import type { FigmaSourceContext } from "./product-context.js";
import { renderFigmaProjectContext } from "./product-context.js";

export async function assembleCodexFigmaPrompt(catalog: FigmaPromptCatalog, plan: FigmaMetaPlan, context: FigmaSourceContext) {
  const prompts = await catalog.orderedSelection(plan.selection);
  const reusableAssets = await catalog.reusableAssetRegistry();
  const sections = [
    "# Codex Figma Prototype Task\nUse the available Figma tooling to create or modify the requested editable prototype. Follow the complete inherited prompt and confirmed project context below. The output of this artifact is an execution prompt for Codex; do not reinterpret it as a new product-design stage.",
    ...prompts.map(prompt => [
      `<!-- FIGMA_PROMPT_START ${prompt.entry.id} -->`,
      prompt.content.trim(),
      `<!-- FIGMA_PROMPT_END ${prompt.entry.id} -->`
    ].join("\n")),
    `# Reusable Asset Registry\nTreat these as reuse candidates. Verify that an asset is actually accessible and suitable in the target Figma file before using it.\n\n${reusableAssets.trim()}`,
    renderFigmaProjectContext(context)
  ];
  const totalPrompt = sections.join("\n\n");
  return {
    totalPrompt,
    totalPromptHash: createHash("sha256").update(totalPrompt).digest("hex"),
    selectedPromptIds: prompts.map(prompt => prompt.entry.id),
    promptHashes: Object.fromEntries(prompts.map(prompt => [prompt.entry.id, prompt.hash]))
  };
}

