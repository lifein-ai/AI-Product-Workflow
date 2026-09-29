import "../src/config/load-env.js";
import { createAIProvider } from "../src/ai/provider-factory.js";

const { provider, info } = createAIProvider();
const response = await provider.generate({
  instructions: "Reply with one short sentence confirming the AI provider is working.",
  input: [{ role: "user", content: "AI provider smoke test" }],
  toolNames: []
});

if (!response.text.trim()) throw new Error("AI provider returned no text");
console.log(`${info.label} OK: ${response.text.trim()}`);
