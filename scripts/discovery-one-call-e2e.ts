import "../src/config/load-env.js";
import { performance } from "node:perf_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { createAIProvider } from "../src/ai/provider-factory.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";

const requirement = "我们刚上线了主播 1v1 PK 功能，但现在使用 PK 的主播比较少。我想做点东西促进主播使用 PK，同时也希望看看 PK 能不能带动礼物流水。";
const tracePath = "reports/creator-pk-one-call-trace.jsonl";
const resultPath = "reports/creator-pk-one-call-e2e.json";
process.env.LATENCY_INSTRUMENTATION = "1";
process.env.LATENCY_AUDIT_FILE = tracePath;
await mkdir("reports", { recursive: true });
await writeFile(tracePath, "", "utf8");

const provider = createAIProvider().provider;
let providerCalls = 0;
const providerOutputs: Array<{ text: string; calls: Array<{ name: string; arguments: string }> }> = [];
const measuredProvider: AIProvider = {
  async generate(request) {
    providerCalls += 1;
    const response = await provider.generate(request);
    providerOutputs.push({
      text: response.text,
      calls: response.calls.map(call => ({ name: call.name, arguments: call.arguments }))
    });
    return response;
  }
};
const app = Fastify({ logger: false });
const repo = new InMemoryProjectRepository();
await app.register(projectRoutes, { repo, runtime: new RuntimeService(repo, measuredProvider) });

try {
  const created = await app.inject({
    method: "POST",
    url: "/projects",
    payload: { name: "Creator PK One-call E2E", initialRequirement: requirement }
  });
  if (created.statusCode !== 201) throw new Error(created.body);
  const projectId = created.json().id as string;
  const requestId = `creator-pk-one-call-${Date.now().toString(36)}`;
  const startedAt = performance.now();
  const response = await app.inject({
    method: "POST",
    url: `/projects/${projectId}/messages`,
    headers: { "x-request-id": requestId },
    payload: { content: requirement }
  });
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  if (response.statusCode !== 200) throw new Error(`${response.statusCode}: ${response.body}`);
  if (providerCalls !== 1) throw new Error(`Expected one Provider call, received ${providerCalls}`);

  const body = response.json();
  const project = body.project;
  const traces = (await readFile(tracePath, "utf8")).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const report = {
    runAt: new Date().toISOString(),
    requestId,
    requirement,
    durationMs,
    providerCalls,
    reply: body.reply,
    status: project.workflow.stages.DISCOVERY.status,
    revision: project.productSpec.version.revision,
    primaryGoal: project.productSpec.discovery.goals.primary,
    secondaryGoals: project.productSpec.discovery.goals.secondary,
    behaviorChange: project.productSpec.discovery.behaviorChange,
    openQuestions: project.productSpec.openQuestions,
    decisions: project.productSpec.decisions,
    trace: traces.at(-1)
  };
  await writeFile(resultPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify({
    resultPath,
    durationMs,
    providerCalls,
    status: report.status,
    revision: report.revision,
    blockingQuestions: report.openQuestions.filter((question: { blocking: boolean; status: string }) => question.blocking && question.status === "OPEN").length,
    llmCallsInTrace: report.trace?.llmCalls?.length
  }, null, 2));
} catch (error) {
  await writeFile(resultPath, JSON.stringify({
    runAt: new Date().toISOString(), requirement, providerCalls, providerOutputs,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2), "utf8");
  throw error;
} finally {
  await app.close();
}
