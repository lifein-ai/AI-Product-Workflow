import OpenAI from "openai";

const apiKey = process.env.MODELFLARE_API_KEY;
const baseURL = process.env.MODELFLARE_BASE_URL;
const model = process.env.MODELFLARE_MODEL;

if (!apiKey || !baseURL || !model) {
  throw new Error(
    "Missing MODELFLARE_API_KEY / MODELFLARE_BASE_URL / MODELFLARE_MODEL"
  );
}

const client = new OpenAI({
  apiKey,
  baseURL,
  timeout: 300_000,
  maxRetries: 0,
});

console.log("Model:", model);
console.log("Base URL:", baseURL);
console.log("Starting minimal benchmark...\n");

const start = performance.now();

const response = await client.responses.create({
  model,
  input: "Reply only with OK.",
  max_output_tokens: 16,
  store: false,
});

const duration = performance.now() - start;

console.log("===== RESULT =====");
console.log("Duration:", `${(duration / 1000).toFixed(2)}s`);
console.log("Response:", response.output_text);
console.log("Usage:", JSON.stringify(response.usage, null, 2));