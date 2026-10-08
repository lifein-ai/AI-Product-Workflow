import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { createProjectRecord } from "../src/domain/factories.js";
import { PrdService } from "../src/prd/prd-service.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";
import { RequestProgressStore } from "../src/runtime/request-progress.js";

test("PRD artifact API enforces confirmed sources and exposes generate, edit, and confirm", async () => {
  const app = Fastify();
  const repo = new InMemoryProjectRepository();
  const ai: AIProvider = {
    async generate(request) {
      const meta = {
        schemaVersion: "prd-meta-plan.v1",
        analysis: { requirementType: "功能", domains: [], coreObjects: [], roles: ["User"], goal: "输出需求详情" },
        selection: {
          baseId: "prd.base",
          domainCapabilityIds: [],
          generalCapabilityIds: ["prd.capability.feature"],
          supportCapabilityIds: [],
          projectPromptIds: []
        },
        capabilityGaps: [], canGenerate: true, blockingIssues: []
      };
      const generation = {
        result: "GENERATED",
        requirementDetailsMarkdown: "## 功能需求\n\n- 用户可以完成目标。\n\n原型示意：功能页",
        openQuestions: [], generationNotes: []
      };
      const name = request.toolNames[0];
      return {
        text: "",
        calls: [{ callId: name, name, arguments: JSON.stringify(name === "complete_prd_meta_analysis" ? meta : generation) }],
        historyItems: []
      };
    }
  };
  const runtime = new RuntimeService(repo, ai);
  const prd = new PrdService(repo, ai);
  const requestProgress = new RequestProgressStore();
  await app.register(projectRoutes, { repo, runtime, prd, requestProgress });

  try {
    const unconfirmed = await repo.create(createProjectRecord("Unconfirmed", "普通功能"));
    const rejected = await app.inject({ method: "POST", url: `/projects/${unconfirmed.id}/artifacts/prd/generate` });
    assert.equal(rejected.statusCode, 409);

    const project = createProjectRecord("Confirmed", "普通功能");
    project.workflow.stages.DISCOVERY.status = "CONFIRMED";
    project.workflow.stages.DISCOVERY.confirmedVersion = 0;
    project.workflow.stages.SOLUTION.status = "CONFIRMED";
    project.workflow.stages.SOLUTION.confirmedVersion = 0;
    const confirmed = await repo.create(project);

    const generated = await app.inject({
      method: "POST",
      url: `/projects/${confirmed.id}/artifacts/prd/generate`,
      headers: { "x-request-id": "prd-progress" }
    });
    assert.equal(generated.statusCode, 200);
    assert.equal(generated.json().artifact.reviewStatus, "DRAFT");
    const progress = await app.inject({ method: "GET", url: "/requests/prd-progress" });
    assert.equal(progress.json().phase, "COMPLETED");

    const edited = await app.inject({
      method: "PATCH",
      url: `/projects/${confirmed.id}/artifacts/prd`,
      payload: { content: "## 人工修订\n\n- 已检查。\n\n原型示意：功能页" }
    });
    assert.equal(edited.statusCode, 200);
    assert.match(edited.json().artifact.currentContent, /人工修订/);

    const prdConfirmed = await app.inject({ method: "POST", url: `/projects/${confirmed.id}/artifacts/prd/confirm` });
    assert.equal(prdConfirmed.statusCode, 200);
    assert.equal(prdConfirmed.json().artifact.reviewStatus, "CONFIRMED");
  } finally {
    await app.close();
  }
});

test("PRD clarification API resumes a blocked artifact with one Generation call", async () => {
  const app = Fastify();
  const repo = new InMemoryProjectRepository();
  let calls = 0;
  const ai: AIProvider = {
    async generate(request) {
      calls += 1;
      const name = request.toolNames[0];
      const args = name === "complete_prd_meta_analysis"
        ? {
            schemaVersion: "prd-meta-plan.v1",
            analysis: { requirementType: "功能", domains: [], coreObjects: [], roles: ["User"], goal: "输出需求详情" },
            selection: { baseId: "prd.base", domainCapabilityIds: [], generalCapabilityIds: ["prd.capability.feature"], supportCapabilityIds: [], projectPromptIds: [] },
            capabilityGaps: [], canGenerate: true, blockingIssues: []
          }
        : calls === 2
          ? { result: "NEEDS_INPUT", openQuestions: [{ question: "采用哪个时区？", impact: "影响时间边界", scope: "ARTIFACT_DETAIL" }], generationNotes: [] }
          : { result: "GENERATED", requirementDetailsMarkdown: "## 时间规则\n\n- 使用 Asia/Shanghai。", openQuestions: [], generationNotes: [] };
      return { text: "", calls: [{ callId: name, name, arguments: JSON.stringify(args) }], historyItems: [] };
    }
  };
  await app.register(projectRoutes, { repo, runtime: new RuntimeService(repo, ai), prd: new PrdService(repo, ai) });

  try {
    const project = createProjectRecord("Clarification", "普通功能");
    project.workflow.stages.DISCOVERY.status = "CONFIRMED";
    project.workflow.stages.DISCOVERY.confirmedVersion = 0;
    project.workflow.stages.SOLUTION.status = "CONFIRMED";
    project.workflow.stages.SOLUTION.confirmedVersion = 0;
    const created = await repo.create(project);
    const blocked = await app.inject({ method: "POST", url: `/projects/${created.id}/artifacts/prd/generate` });
    assert.equal(blocked.json().artifact.reviewStatus, "BLOCKED");

    const resumed = await app.inject({
      method: "POST",
      url: `/projects/${created.id}/artifacts/prd/clarify`,
      payload: { answer: "统一采用 Asia/Shanghai。" }
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.json().artifact.reviewStatus, "DRAFT");
    assert.equal(resumed.json().artifact.clarifications.length, 1);
    assert.equal(calls, 3);
  } finally {
    await app.close();
  }
});
