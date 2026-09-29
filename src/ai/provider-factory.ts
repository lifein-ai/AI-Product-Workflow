import { resolve } from "node:path";
import type { AIProvider } from "./provider.js";
import { CodexProvider } from "./codex-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import {
  createProviderProfile,
  ProviderLibrary,
  type ProviderProfileRecord
} from "./provider-library.js";

export type AIProviderId = "relay" | "codex";

export interface AIProviderSelection {
  provider: AIProvider;
  library: ProviderLibrary;
  initialize(): Promise<void>;
  info: {
    id: AIProviderId;
    label: "Relay" | "Codex Local";
    status: "Ready";
  };
}

export function createAIProvider(
  environment: NodeJS.ProcessEnv = process.env,
  options: { libraryPath?: string | null } = {}
): AIProviderSelection {
  const providerId = (environment.AI_PROVIDER?.trim().toLowerCase() || "relay") as AIProviderId;
  if (providerId !== "relay" && providerId !== "codex") {
    throw new Error(`Provider initialization failed: unsupported AI_PROVIDER "${environment.AI_PROVIDER}". Use relay or codex.`);
  }

  const storagePath = options.libraryPath === undefined
    ? environment === process.env
      ? resolve(environment.WORKFLOW_PROVIDER_LIBRARY_PATH?.trim() || ".runtime/provider-library.json")
      : null
    : options.libraryPath;
  let library: ProviderLibrary;
  try {
    library = new ProviderLibrary({
      storagePath,
      seedProfiles: seedProfiles(environment),
      preferredKind: providerId === "codex" ? "codex" : "openai-compatible",
      instantiate: profile => instantiateProfile(profile, environment)
    });
  } catch (error) {
    throw providerInitializationError(error);
  }

  return {
    provider: library,
    library,
    initialize: async () => {
      try {
        await library.initialize();
      } catch (error) {
        throw providerInitializationError(error);
      }
    },
    get info() {
      const active = library.getActiveRecord();
      return {
        id: (active.kind === "codex" ? "codex" : "relay") as AIProviderId,
        label: (active.kind === "codex" ? "Codex Local" : "Relay") as "Codex Local" | "Relay",
        status: "Ready" as const
      };
    }
  };
}

function seedProfiles(environment: NodeJS.ProcessEnv): ProviderProfileRecord[] {
  const profiles = [createProviderProfile({
    id: "codex-local",
    name: "Codex Local",
    kind: "codex",
    models: environment.CODEX_MODEL?.trim() ? [environment.CODEX_MODEL.trim()] : [],
    activeModel: environment.CODEX_MODEL?.trim() || "",
    builtIn: true
  })];
  const apiKey = environment.MODELFLARE_API_KEY ?? environment.OPENAI_API_KEY;
  const baseURL = environment.MODELFLARE_BASE_URL ?? environment.OPENAI_BASE_URL;
  const model = environment.MODELFLARE_MODEL ?? environment.OPENAI_MODEL;
  if (apiKey && baseURL && model) profiles.push(createProviderProfile({
    id: "relay-default",
    name: "Relay",
    kind: "openai-compatible",
    baseURL,
    apiKey,
    models: [model],
    activeModel: model,
    builtIn: false
  }));
  return profiles;
}

function instantiateProfile(profile: ProviderProfileRecord, environment: NodeJS.ProcessEnv) {
  if (profile.kind === "codex") {
    const provider = new CodexProvider({
      command: environment.CODEX_COMMAND?.trim() || undefined,
      model: profile.activeModel || environment.CODEX_MODEL?.trim() || undefined
    });
    return { provider, initialize: () => provider.initialize() };
  }
  const provider = new OpenAIProvider({
    apiKey: profile.apiKey,
    baseURL: profile.baseURL,
    model: profile.activeModel,
    streaming: environment.MODELFLARE_STREAMING === "1"
  });
  return { provider, initialize: async () => undefined };
}

function providerInitializationError(error: unknown): Error {
  return new Error(`Provider initialization failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}
