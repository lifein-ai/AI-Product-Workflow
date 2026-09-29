import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { InMemoryProjectRepository } from "../src/repositories/in-memory-project-repository.js";
import { projectRoutes } from "../src/routes/projects.js";
import { RuntimeService } from "../src/runtime/runtime-service.js";

test("project management API lists, renames, exports, cleans artifacts, and deletes", async () => {
  const app = Fastify();
  const repo = new InMemoryProjectRepository();
  const ai: AIProvider = { async generate() { throw new Error("not expected"); } };
  await app.register(projectRoutes, { repo, runtime: new RuntimeService(repo, ai) });
  try {
    const createdResponse = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Original", initialRequirement: "Persist and manage projects" }
    });
    const created = createdResponse.json();
    const id = created.id as string;

    const list = await app.inject({ method: "GET", url: "/projects" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().projects[0].name, "Original");
    assert.equal(list.json().projects[0].storage.kind, "memory");

    const renamed = await app.inject({ method: "PATCH", url: `/projects/${id}`, payload: { name: "Renamed" } });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().productSpec.project.name, "Renamed");

    const mutable = await repo.getById(id);
    assert.ok(mutable);
    mutable.artifacts.prd.lifecycleStatus = "STALE";
    mutable.artifacts.prd.reviewStatus = "DRAFT";
    mutable.artifacts.prd.currentContent = "obsolete";
    mutable.artifacts.figmaPrompt.lifecycleStatus = "CURRENT";
    mutable.artifacts.figmaPrompt.reviewStatus = "DRAFT";
    mutable.artifacts.figmaPrompt.currentContent = "downstream";
    await repo.save(mutable);

    const cleaned = await app.inject({ method: "POST", url: `/projects/${id}/artifacts/cleanup`, payload: {} });
    assert.deepEqual(cleaned.json().removed, ["prd", "interaction", "figmaPrompt"]);
    assert.equal(cleaned.json().project.artifacts.prd.lifecycleStatus, "NOT_GENERATED");
    assert.equal(cleaned.json().project.artifacts.figmaPrompt.lifecycleStatus, "NOT_GENERATED");

    const exported = await app.inject({ method: "GET", url: `/projects/${id}/export` });
    assert.equal(exported.statusCode, 200);
    assert.match(exported.headers["content-disposition"] ?? "", /attachment/);
    assert.equal(JSON.parse(exported.body).productSpec.project.name, "Renamed");

    assert.equal((await app.inject({ method: "DELETE", url: `/projects/${id}` })).statusCode, 204);
    assert.equal((await app.inject({ method: "GET", url: `/projects/${id}` })).statusCode, 404);
  } finally {
    await app.close();
  }
});
