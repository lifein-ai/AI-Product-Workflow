import "../src/config/load-env.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { createAIProvider } from "../src/ai/provider-factory.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";

const initialRequirement = "我们刚上线一个主播 1v1 PK 功能，但现在平台主播数量和观众数量都比较少。我想做一个活动促进主播使用 PK，也希望顺便验证 PK 是否能够带动礼物流水。";
process.env.RUNTIME_TOOL_TRACE = "1";
const app = Fastify({ logger: false });
const repo = new InMemoryProjectRepository();
const modelProvider = createAIProvider().provider;
let providerCall = 0;
const tracedProvider: AIProvider = {
  async generate(request) {
    const call = ++providerCall;
    const startedAt = Date.now();
    console.log(`[provider] call ${call} started; tools=${request.toolNames.length}`);
    try {
      const response = await modelProvider.generate(request);
      console.log(`[provider] call ${call} completed in ${Date.now() - startedAt}ms; toolCalls=${response.calls.length}; text=${response.text.length}`);
      for (const toolCall of response.calls) console.log(`[provider] tool ${toolCall.name} args=${toolCall.arguments}`);
      return response;
    } catch (error) {
      console.error(`[provider] call ${call} failed in ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
};
const runtime = new RuntimeService(repo, tracedProvider);
await app.register(projectRoutes, { repo, runtime });
const terminal = createInterface({ input: stdin, output: stdout });
const turns: unknown[] = [];

try {
  const created = await app.inject({ method: "POST", url: "/projects", payload: { name: "Creator PK Launch Campaign", initialRequirement } });
  if (created.statusCode !== 201) throw new Error(created.body);
  const projectId = created.json().id as string;
  let userMessage = initialRequirement;

  for (let turn = 1; turn <= 20; turn++) {
    const response = await app.inject({ method: "POST", url: `/projects/${projectId}/messages`, payload: { content: userMessage } });
    if (response.statusCode !== 200) throw new Error(`Turn ${turn}: ${response.statusCode} ${response.body}`);
    const body = response.json();
    const project = body.project;
    turns.push({ turn, user: userMessage, assistant: body.reply, project });
    await mkdir("reports", { recursive: true });
    await writeFile("reports/creator-pk-discovery-e2e.json", JSON.stringify({ initialRequirement, turns }, null, 2));
    console.log(`\n=== Turn ${turn} ===`);
    console.log(`AI: ${body.reply}`);
    console.log(JSON.stringify({
      revision: project.productSpec.version.revision,
      status: project.workflow.stages.DISCOVERY.status,
      openQuestions: project.productSpec.openQuestions,
      decisions: project.productSpec.decisions,
      discovery: project.productSpec.discovery
    }, null, 2));
    if (project.workflow.stages.DISCOVERY.status === "READY_FOR_CONFIRMATION") {
      console.log("\nDISCOVERY_READY");
      break;
    }
    userMessage = await terminal.question("\nUser> ");
    if (!userMessage.trim()) throw new Error("A non-empty user answer is required");
    if (turn === 20) throw new Error("Discovery did not become ready within 20 turns");
  }
} finally {
  terminal.close();
  await app.close();
}
