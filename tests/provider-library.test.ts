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
    assert.deepEqual(listed.json().decisionExtraction, {
      profileId: "relay-default",
      profileName: "Relay",
      model: "model-a"
    });
    assert.equal(listed.json().profiles[1].apiKeyMasked, "••••inal");
    assert.doesNotMatch(listed.body, /secret-original/);

    const decisionProvider = await app.inject({
      method: "POST",
      url: "/api/providers/decision-extraction",
      payload: { profileId: "relay-default", model: "model-b" }
    });
    assert.equal(decisionProvider.statusCode, 200);
    assert.equal(decisionProvider.json().decisionExtraction.model, "model-b");
    await library.generateDecision({ instructions: "decision", input: [], toolNames: [] });

    const codexMain = await app.inject({ method: "POST", url: "/api/providers/codex-local/activate", payload: {} });
    assert.equal(codexMain.statusCode, 200);
    await library.generate({ instructions: "main-codex", input: [], toolNames: [] });
    await library.generateDecision({ instructions: "decision-with-codex-main", input: [], toolNames: [] });

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
    assert.deepEqual(initialized, ["codex-local", backup.id]);
    await library.generate({ instructions: "test", input: [], toolNames: [] });
    await library.generateDecision({ instructions: "decision-again", input: [], toolNames: [] });
    assert.deepEqual(generated, [
      "relay-default:model-b",
      "codex-local:",
      "relay-default:model-b",
      `${backup.id}:model-x`,
      "relay-default:model-b"
    ]);

    const cannotDeleteDecisionProvider = await app.inject({ method: "DELETE", url: "/api/providers/relay-default" });
    assert.equal(cannotDeleteDecisionProvider.statusCode, 409);

    const cannotDeleteActive = await app.inject({ method: "DELETE", url: `/api/providers/${backup.id}` });
    assert.equal(cannotDeleteActive.statusCode, 409);
    assert.doesNotMatch(cannotDeleteActive.body, /secret-backup/);

    const persisted = JSON.parse(readFileSync(storagePath, "utf8"));
    assert.equal(persisted.activeProfileId, backup.id);
    assert.deepEqual(persisted.decisionExtraction, { profileId: "relay-default", model: "model-b" });
    assert.equal(persisted.profiles.find((profile: { id: string }) => profile.id === backup.id).apiKey, "secret-backup");
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Provider library falls back to a configured API when the saved local provider cannot initialize", async () => {
  const directory = mkdtempSync(join(tmpdir(), "provider-library-fallback-test-"));
  const storagePath = join(directory, "providers.json");
  const seedProfiles = [
    createProviderProfile({
      id: "codex-local", name: "Codex Local", kind: "codex", models: [], activeModel: "", builtIn: true
    }),
    createProviderProfile({
      id: "relay-default", name: "Relay", kind: "openai-compatible", baseURL: "https://relay.invalid/v1",
      apiKey: "secret", models: ["model-a"], activeModel: "model-a", builtIn: false
    })
  ];
  const createLibrary = () => new ProviderLibrary({
    storagePath,
    preferredKind: "codex",
    seedProfiles,
    instantiate(profile) {
      const provider: AIProvider = { async generate() { return { text: profile.id, calls: [], historyItems: [] }; } };
      return {
        provider,
        initialize: async () => {
          if (profile.kind === "codex") throw new Error("login expired");
        }
      };
    }
  });

  try {
    const library = createLibrary();
    await library.initialize();
    assert.equal(library.getState().activeProfileId, "relay-default");
    assert.equal(JSON.parse(readFileSync(storagePath, "utf8")).activeProfileId, "relay-default");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
