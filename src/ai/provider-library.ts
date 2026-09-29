import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { AIProvider, AIProviderRequest, ModelResponse } from "./provider.js";

export type ProviderProfileKind = "codex" | "openai-compatible";

export interface ProviderProfileRecord {
  id: string;
  name: string;
  kind: ProviderProfileKind;
  baseURL?: string;
  apiKey?: string;
  models: string[];
  activeModel: string;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfileView {
  id: string;
  name: string;
  kind: ProviderProfileKind;
  baseURL: string | null;
  models: string[];
  activeModel: string;
  builtIn: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderLibraryState {
  activeProfileId: string;
  active: ProviderProfileView;
  profiles: ProviderProfileView[];
}

export interface ProviderInstance {
  provider: AIProvider;
  initialize(): Promise<void>;
}

interface PersistedProviderLibrary {
  version: 1;
  activeProfileId: string;
  profiles: ProviderProfileRecord[];
}

const profileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["codex", "openai-compatible"]),
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
  models: z.array(z.string().min(1)),
  activeModel: z.string(),
  builtIn: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const librarySchema = z.object({
  version: z.literal(1),
  activeProfileId: z.string(),
  profiles: z.array(profileSchema)
});

export class ProviderLibraryError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ProviderLibraryError";
  }
}

export class ProviderLibrary implements AIProvider {
  private readonly storagePath: string | null;
  private readonly instantiate: (profile: ProviderProfileRecord) => ProviderInstance;
  private profiles: ProviderProfileRecord[];
  private activeProfileId: string;
  private activeInstance: ProviderInstance;

  constructor(options: {
    storagePath: string | null;
    seedProfiles: ProviderProfileRecord[];
    preferredKind: ProviderProfileKind;
    instantiate(profile: ProviderProfileRecord): ProviderInstance;
  }) {
    this.storagePath = options.storagePath;
    this.instantiate = options.instantiate;
    const persisted = this.readPersisted();
    this.profiles = mergeProfiles(persisted?.profiles ?? [], options.seedProfiles, persisted === null);
    this.activeProfileId = selectInitialProfile(this.profiles, persisted?.activeProfileId, options.preferredKind);
    this.activeInstance = this.instantiate(this.requireRecord(this.activeProfileId));
  }

  async initialize(): Promise<void> {
    await this.activeInstance.initialize();
  }

  async generate(request: AIProviderRequest): Promise<ModelResponse> {
    return this.activeInstance.provider.generate(request);
  }

  getState(): ProviderLibraryState {
    const profiles = this.profiles.map(toView);
    const active = profiles.find(profile => profile.id === this.activeProfileId);
    if (!active) throw new ProviderLibraryError("Active provider profile not found", 500);
    return { activeProfileId: this.activeProfileId, active, profiles };
  }

  getActiveRecord(): ProviderProfileRecord {
    const active = this.requireRecord(this.activeProfileId);
    return { ...active, models: [...active.models] };
  }

  createApiProfile(input: {
    name: string;
    baseURL: string;
    apiKey: string;
    models: string[];
    activeModel?: string;
  }): ProviderLibraryState {
    const models = normalizeModels(input.models);
    const activeModel = input.activeModel?.trim() || models[0];
    if (!models.includes(activeModel)) throw new ProviderLibraryError("Default model must be included in models");
    const timestamp = new Date().toISOString();
    const record: ProviderProfileRecord = {
      id: `api-${randomUUID()}`,
      name: input.name.trim(),
      kind: "openai-compatible",
      baseURL: normalizeBaseURL(input.baseURL),
      apiKey: input.apiKey.trim(),
      models,
      activeModel,
      builtIn: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    if (!record.name) throw new ProviderLibraryError("Profile name is required");
    if (!record.apiKey) throw new ProviderLibraryError("API key is required");
    this.profiles.push(record);
    this.persist();
    return this.getState();
  }

  async updateApiProfile(id: string, input: {
    name?: string;
    baseURL?: string;
    apiKey?: string;
    models?: string[];
    activeModel?: string;
  }): Promise<ProviderLibraryState> {
    const index = this.profiles.findIndex(profile => profile.id === id);
    if (index < 0) throw new ProviderLibraryError("Provider profile not found", 404);
    const current = this.profiles[index];
    if (current.builtIn || current.kind !== "openai-compatible") {
      throw new ProviderLibraryError("Built-in provider profiles cannot be edited", 409);
    }
    const models = input.models === undefined ? current.models : normalizeModels(input.models);
    const activeModel = input.activeModel?.trim() || (models.includes(current.activeModel) ? current.activeModel : models[0]);
    if (!models.includes(activeModel)) throw new ProviderLibraryError("Default model must be included in models");
    const updated: ProviderProfileRecord = {
      ...current,
      name: input.name === undefined ? current.name : input.name.trim(),
      baseURL: input.baseURL === undefined ? current.baseURL : normalizeBaseURL(input.baseURL),
      apiKey: input.apiKey?.trim() || current.apiKey,
      models,
      activeModel,
      updatedAt: new Date().toISOString()
    };
    if (!updated.name) throw new ProviderLibraryError("Profile name is required");
    if (!updated.apiKey) throw new ProviderLibraryError("API key is required");
    const instance = this.instantiate(updated);
    if (id === this.activeProfileId) await instance.initialize();
    this.profiles[index] = updated;
    if (id === this.activeProfileId) this.activeInstance = instance;
    this.persist();
    return this.getState();
  }

  async activate(id: string, model?: string): Promise<ProviderLibraryState> {
    const current = this.requireRecord(id);
    const selectedModel = model?.trim() || current.activeModel;
    if (selectedModel && !current.models.includes(selectedModel)) {
      throw new ProviderLibraryError("Selected model is not configured for this provider");
    }
    const updated = selectedModel === current.activeModel
      ? current
      : { ...current, activeModel: selectedModel, updatedAt: new Date().toISOString() };
    const instance = this.instantiate(updated);
    await instance.initialize();
    this.profiles = this.profiles.map(profile => profile.id === id ? updated : profile);
    this.activeProfileId = id;
    this.activeInstance = instance;
    this.persist();
    return this.getState();
  }

  deleteProfile(id: string): ProviderLibraryState {
    const profile = this.requireRecord(id);
    if (profile.builtIn) throw new ProviderLibraryError("Built-in provider profiles cannot be deleted", 409);
    if (id === this.activeProfileId) throw new ProviderLibraryError("The active provider profile cannot be deleted", 409);
    this.profiles = this.profiles.filter(candidate => candidate.id !== id);
    this.persist();
    return this.getState();
  }

  private requireRecord(id: string): ProviderProfileRecord {
    const record = this.profiles.find(profile => profile.id === id);
    if (!record) throw new ProviderLibraryError("Provider profile not found", 404);
    return record;
  }

  private readPersisted(): PersistedProviderLibrary | null {
    if (!this.storagePath) return null;
    try {
      return librarySchema.parse(JSON.parse(readFileSync(this.storagePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ProviderLibraryError("Provider library file is invalid", 500);
    }
  }

  private persist(): void {
    if (!this.storagePath) return;
    mkdirSync(dirname(this.storagePath), { recursive: true });
    const data: PersistedProviderLibrary = { version: 1, activeProfileId: this.activeProfileId, profiles: this.profiles };
    writeFileSync(this.storagePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

export function createProviderProfile(input: Omit<ProviderProfileRecord, "createdAt" | "updatedAt">): ProviderProfileRecord {
  const timestamp = new Date().toISOString();
  return { ...input, models: [...input.models], createdAt: timestamp, updatedAt: timestamp };
}

function mergeProfiles(persisted: ProviderProfileRecord[], seeds: ProviderProfileRecord[], includeNewSeeds: boolean): ProviderProfileRecord[] {
  const merged = persisted.map(profile => ({ ...profile, models: [...profile.models] }));
  for (const seed of seeds) {
    const index = merged.findIndex(profile => profile.id === seed.id);
    if (index < 0 && (includeNewSeeds || seed.builtIn)) merged.push({ ...seed, models: [...seed.models] });
    else if (seed.builtIn) merged[index] = { ...seed, createdAt: merged[index].createdAt };
  }
  return merged;
}

function selectInitialProfile(profiles: ProviderProfileRecord[], persistedActiveId: string | undefined, preferredKind: ProviderProfileKind): string {
  const persisted = profiles.find(profile => profile.id === persistedActiveId && profile.kind === preferredKind);
  if (persisted) return persisted.id;
  const preferred = profiles.find(profile => profile.kind === preferredKind);
  if (preferred) return preferred.id;
  throw new ProviderLibraryError(preferredKind === "codex"
    ? "Codex provider profile is not available"
    : "MODELFLARE_API_KEY, MODELFLARE_BASE_URL, and MODELFLARE_MODEL are required until an API profile is saved", 503);
}

function normalizeModels(models: string[]): string[] {
  const normalized = [...new Set(models.map(model => model.trim()).filter(Boolean))];
  if (normalized.length === 0) throw new ProviderLibraryError("At least one model is required");
  if (normalized.length > 100) throw new ProviderLibraryError("A provider can contain at most 100 models");
  return normalized;
}

function normalizeBaseURL(value: string): string {
  const baseURL = value.trim().replace(/\/$/, "");
  try {
    const url = new URL(baseURL);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    throw new ProviderLibraryError("Base URL must be a valid HTTP or HTTPS URL");
  }
  return baseURL;
}

function toView(profile: ProviderProfileRecord): ProviderProfileView {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    baseURL: profile.baseURL ?? null,
    models: [...profile.models],
    activeModel: profile.activeModel,
    builtIn: profile.builtIn,
    hasApiKey: Boolean(profile.apiKey),
    apiKeyMasked: profile.apiKey ? maskApiKey(profile.apiKey) : null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 4) return "••••";
  return `••••${apiKey.slice(-4)}`;
}
