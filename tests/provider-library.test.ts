import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import type { AIProvider } from "../src/ai/provider.js";
import { createProviderProfile, ProviderLibrary } from "../src/ai/provider-library.js";
import { providerRoutes } from "../src/routes/providers.js";

test("Provider library stores multiple APIs and models, masks keys, and switches the shared provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-library-test-"));
  const storagePath = join(directory, "providers.json");
  const initialized: string[] = [];
  const generated: string[] = [];
  const library = new ProviderLibrary({
    storagePath,
    preferredKind: "openai-compatible",
    seedProfiles: [
      createProviderProfile({
        id: "codex-local", name: "Codex Local", kind: "codex", models: [], activeModel: "", builtIn: true
      }),
      createProviderProfile({
        id: "relay-default", name: "Relay", kind: "openai-compatible", baseURL: "https://relay.invalid/v1",
        apiKey: "secret-original", models: ["model-a", "model-b"], activeModel: "model-a", builtIn: false
      })
    ],
    instantiate(profile) {
      const provider: AIProvider = { async generate() {
        generated.push(`${profile.id}:${profile.activeModel}`);
        return { text: profile.id, calls: [], historyItems: [] };
      } };
      return { provider, initialize: async () => { initialized.push(profile.id); } };
    }
  });
  const app = Fastify();
  await app.register(providerRoutes, { library });
  try {
    const listed = await app.inject({ method: "GET", url: "/api/providers" });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().activeProfileId, "relay-default");
    assert.equal(listed.json().profiles[1].apiKeyMasked, "••••inal");
    assert.doesNotMatch(listed.body, /secret-original/);

    const created = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        name: "Backup API",
        baseURL: "https://backup.invalid/v1/",
        apiKey: "secret-backup",
        models: ["model-x", "model-y"],
        activeModel: "model-y"
      }
    });
    assert.equal(created.statusCode, 201);
    const backup = created.json().profiles.find((profile: { name: string }) => profile.name === "Backup API");
    assert.ok(backup);
    assert.equal(backup.baseURL, "https://backup.invalid/v1");

    const activated = await app.inject({
      method: "POST",
      url: `/api/providers/${backup.id}/activate`,
      payload: { model: "model-x" }
    });
    assert.equal(activated.statusCode, 200);
    assert.equal(activated.json().active.activeModel, "model-x");
    assert.deepEqual(initialized, [backup.id]);
    await library.generate({ instructions: "test", input: [], toolNames: [] });
    assert.deepEqual(generated, [`${backup.id}:model-x`]);

    const cannotDeleteActive = await app.inject({ method: "DELETE", url: `/api/providers/${backup.id}` });
    assert.equal(cannotDeleteActive.statusCode, 409);
    assert.doesNotMatch(cannotDeleteActive.body, /secret-backup/);

    const persisted = JSON.parse(readFileSync(storagePath, "utf8"));
    assert.equal(persisted.activeProfileId, backup.id);
    assert.equal(persisted.profiles.find((profile: { id: string }) => profile.id === backup.id).apiKey, "secret-backup");
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
