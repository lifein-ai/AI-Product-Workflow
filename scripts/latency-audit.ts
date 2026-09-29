import "../src/config/load-env.js";
import { performance } from "node:perf_hooks";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { request as httpRequest } from "node:http";
import Fastify from "fastify";
import { createAIProvider } from "../src/ai/provider-factory.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";

const rawTracePath = resolve("reports", "latency-audit-raw.jsonl");
const resultPath = resolve("reports", "latency-audit-results.json");
process.env.LATENCY_INSTRUMENTATION = "1";
process.env.LATENCY_AUDIT_FILE = rawTracePath;
await writeFile(rawTracePath, "", "utf8");

const cases = [
  {
    id: "simple",
    name: "Simple onboarding clarity",
    requirement: "我想让新用户更快完成首次创建项目。"
  },
  {
    id: "medium",
    name: "Creator review status",
    requirement: "我们有一个创作者后台。创作者提交视频后看不到审核进度，经常重复咨询运营。我希望减少重复咨询，同时不改变现有审核流程。主要用户是每周至少投稿一次的创作者，现有系统已经记录提交、审核中、通过和驳回状态，但目前只在审核结束时发送站内通知。"
  },
  {
    id: "creator-pk",
    name: "Creator PK launch campaign",
    requirement: "我们刚上线一个主播 1v1 PK 功能，但现在平台主播数量和观众数量都比较少。我想做一个活动促进主播使用 PK，也希望顺便验证 PK 是否能够带动礼物流水。"
  }
];

const app = Fastify({ logger: false });
const repo = new InMemoryProjectRepository();
await app.register(projectRoutes, { repo, runtime: new RuntimeService(repo, createAIProvider().provider) });
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Unable to determine audit server port");
const baseUrl = `http://127.0.0.1:${address.port}`;
const clientResults = [];

function requestJson(url: string, options: { method: string; headers?: Record<string, string>; body?: unknown }): Promise<{
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: any;
}> {
  const target = new URL(url);
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() } : {}),
        ...options.headers
      }
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolveRequest({ status: response.statusCode ?? 0, headers: response.headers, body: text ? JSON.parse(text) : null });
        } catch (error) {
          rejectRequest(error);
        }
      });
    });
    request.on("error", rejectRequest);
    request.setTimeout(0);
    if (payload) request.write(payload);
    request.end();
  });
}

try {
  for (const item of cases) {
    const created = await requestJson(`${baseUrl}/projects`, {
      method: "POST",
      body: { name: item.name, initialRequirement: item.requirement }
    });
    if (created.status < 200 || created.status >= 300) throw new Error(`Create ${item.id} failed: ${created.status} ${JSON.stringify(created.body)}`);
    const project = created.body as { id: string };
    const requestId = `latency-${item.id}-${Date.now().toString(36)}`;
    const startedAt = new Date().toISOString();
    const started = performance.now();
    console.log(`[audit] ${item.id} request ${requestId} started`);
    const response = await requestJson(`${baseUrl}/projects/${project.id}/messages`, {
      method: "POST",
      headers: { "x-request-id": requestId },
      body: { content: item.requirement }
    });
    const body = response.body as {
      error?: string;
      reply?: string;
      project?: { productSpec: { version: { revision: number } }; workflow: { stages: { DISCOVERY: { status: string } } } };
    };
    const totalDurationMs = Math.round((performance.now() - started) * 100) / 100;
    if (response.status < 200 || response.status >= 300) throw new Error(`${item.id} failed: ${response.status} ${body.error ?? "unknown"}`);
    clientResults.push({
      caseId: item.id,
      name: item.name,
      requestId,
      requestStart: startedAt,
      requestEnd: new Date().toISOString(),
      submitToResponseMs: totalDurationMs,
      responseRequestId: response.headers["x-request-id"],
      responseBytes: Number(response.headers["content-length"]) || JSON.stringify(body).length,
      llmReplyCharacters: body.reply?.length ?? 0,
      productSpecRevision: body.project?.productSpec.version.revision,
      discoveryStatus: body.project?.workflow.stages.DISCOVERY.status
    });
    console.log(`[audit] ${item.id} completed in ${totalDurationMs.toLocaleString("en-US")}ms`);
  }
} finally {
  await app.close();
}

const rawLines = (await readFile(rawTracePath, "utf8")).split(/\r?\n/u).filter(Boolean);
const traces = rawLines.map(line => JSON.parse(line));
await writeFile(resultPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  model: process.env.MODELFLARE_MODEL,
  providerBaseUrl: process.env.MODELFLARE_BASE_URL,
  notes: [
    "Provider input/output token totals come from the Responses API usage object.",
    "Per-component token values are local deterministic estimates because the Responses API does not return token usage by prompt section.",
    "TTFT is unavailable because the production Provider uses a non-streaming responses.create call.",
    "reasoningEffort is unspecified because the production request does not send a reasoning parameter."
  ],
  cases,
  clientResults,
  traces
}, null, 2), "utf8");

console.log(`[audit] wrote ${resultPath}`);
