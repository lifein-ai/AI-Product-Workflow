import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProjectRecord } from "../src/domain/factories.js";
import { FileProjectRepository } from "../src/repositories/file-project-repository.js";

test("file repository persists, lists, protects concurrent writes, and deletes one project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "product-workflow-projects-"));
  try {
    const repository = new FileProjectRepository(directory);
    const created = await repository.create(createProjectRecord("Persistent project", "Keep this requirement"));

    const restartedRepository = new FileProjectRepository(directory);
    const restored = await restartedRepository.getById(created.id);
    assert.equal(restored?.productSpec.project.name, "Persistent project");
    assert.equal((await restartedRepository.list()).length, 1);
    assert.equal((await restartedRepository.storageInfo(created.id))?.recordName, `${created.id}.json`);

    const firstWriter = await restartedRepository.getById(created.id);
    const staleWriter = await restartedRepository.getById(created.id);
    assert.ok(firstWriter && staleWriter);
    firstWriter.productSpec.project.name = "Renamed";
    await restartedRepository.save(firstWriter);
    await assert.rejects(() => restartedRepository.save(staleWriter), /changed concurrently/);

    assert.equal(await restartedRepository.delete(created.id), true);
    assert.equal(await restartedRepository.getById(created.id), null);
    assert.equal(await restartedRepository.delete(created.id), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
