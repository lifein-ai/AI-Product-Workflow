import "../src/config/load-env.js";
import { readFile, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { createAIProvider } from "../src/ai/provider-factory.js";
import type { ProjectRecord } from "../src/domain/types.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";

const report = JSON.parse(await readFile("reports/creator-pk-discovery-e2e.json", "utf8"));
const source = report.turns.at(-1)?.project as ProjectRecord | undefined;
if (!source || source.workflow.stages.DISCOVERY.status !== "READY_FOR_CONFIRMATION") {
  throw new Error("A READY Creator PK E2E report is required");
}

process.env.RUNTIME_TOOL_TRACE = "1";
const repo = new InMemoryProjectRepository();
const project = await repo.create(structuredClone(source));
const modelProvider = createAIProvider().provider;
let providerCall = 0;
const tracedProvider: AIProvider = { async generate(request) {
  const call = ++providerCall;
  console.log(`[provider] invalidation call ${call} started`);
  const response = await modelProvider.generate(request);
  console.log(`[provider] invalidation call ${call} completed; toolCalls=${response.calls.length}`);
  for (const toolCall of response.calls) console.log(`[provider] tool ${toolCall.name} args=${toolCall.arguments}`);
  return response;
} };
const app = Fastify({ logger: false });
await app.register(projectRoutes, { repo, runtime: new RuntimeService(repo, tracedProvider) });

try {
  const content = "我修改刚才的决定：随机匹配必须成为本次活动上线前置能力，不能继续只依赖邀请链路。请更新 Discovery，并替代此前‘不将随机匹配作为前置能力’的决定。";
  const response = await app.inject({ method: "POST", url: `/projects/${project.id}/messages`, payload: { content } });
  if (response.statusCode !== 200) throw new Error(`${response.statusCode} ${response.body}`);
  const result = response.json();
  await writeFile("reports/creator-pk-ready-invalidation.json", JSON.stringify({ user: content, result }, null, 2));
  console.log(JSON.stringify({
    status: result.project.workflow.stages.DISCOVERY.status,
    decisions: result.project.productSpec.decisions,
    reply: result.reply
  }, null, 2));
} finally {
  await app.close();
}
