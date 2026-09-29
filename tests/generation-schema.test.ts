import assert from "node:assert/strict";
import test from "node:test";
import { interactionGenerationResultSchema } from "../src/interaction/schemas.js";
import { prdGenerationResultSchema } from "../src/prd/schemas.js";

test("generation adapters infer an omitted result only from unambiguous output", () => {
  const prd = prdGenerationResultSchema.parse({
    requirementDetailsMarkdown: "# Requirement Details",
    openQuestions: [],
    generationNotes: []
  });
  const interaction = interactionGenerationResultSchema.parse({
    openQuestions: [{ question: "Which layout?", impact: "Changes the screen", scope: "ARTIFACT_DETAIL" }],
    generationNotes: []
  });

  assert.equal(prd.result, "GENERATED");
  assert.equal(interaction.result, "NEEDS_INPUT");
  assert.throws(() => prdGenerationResultSchema.parse({ openQuestions: [], generationNotes: [] }));
});
