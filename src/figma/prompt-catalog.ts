import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { FigmaPromptSelection } from "../domain/types.js";

const entrySchema = z.strictObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  layer: z.enum(["CONSTRAINT", "META", "BASE", "CAPABILITY", "MAINTENANCE"]),
  capabilityType: z.enum(["DOMAIN", "SUPPORT"]).optional(),
  status: z.enum(["STABLE", "DRAFT", "DEPRECATED"]),
  path: z.string().nullable(),
  dependencies: z.array(z.string().trim().min(1)),
  selectable: z.boolean()
});

const registrySchema = z.strictObject({
  schemaVersion: z.literal("figma-prompt-registry.v1"),
  humanRegistryPath: z.string().trim().min(1),
  reusableAssetRegistryPath: z.string().trim().min(1),
  entries: z.array(entrySchema).min(1)
});

export type FigmaPromptEntry = z.infer<typeof entrySchema>;

export interface LoadedFigmaPrompt {
  entry: FigmaPromptEntry;
  content: string;
  hash: string;
}

const defaultRegistryPath = resolve(
  process.cwd(),
  "data",
  "03 AI Prompt库",
  "3.2 Figma Prompt体系",
  "Figma Prompt Registry.runtime.json"
);

export class FigmaPromptCatalog {
  private loaded?: {
    root: string;
    entries: Map<string, FigmaPromptEntry>;
    humanRegistry: string;
    reusableAssetRegistry: string;
  };

  constructor(private readonly registryPath = defaultRegistryPath) {}

  async initialize() {
    if (this.loaded) return this.loaded;
    const registry = registrySchema.parse(JSON.parse(await readFile(this.registryPath, "utf8")));
    const root = dirname(this.registryPath);
    const entries = new Map<string, FigmaPromptEntry>();
    for (const entry of registry.entries) {
      if (entries.has(entry.id)) throw new Error(`Duplicate Figma Prompt ID: ${entry.id}`);
      if (entry.layer === "CAPABILITY" && !entry.capabilityType) throw new Error(`Capability ${entry.id} must declare capabilityType`);
      if (entry.status === "STABLE" && !entry.path) throw new Error(`Stable Figma Prompt ${entry.id} must declare a path`);
      entries.set(entry.id, entry);
    }
    for (const entry of entries.values()) {
      for (const dependency of entry.dependencies) {
        if (!entries.has(dependency)) throw new Error(`Figma Prompt ${entry.id} has unknown dependency ${dependency}`);
      }
      if (entry.path) await readFile(resolve(root, entry.path), "utf8");
    }
    const humanRegistry = await readFile(resolve(root, registry.humanRegistryPath), "utf8");
    const reusableAssetRegistry = await readFile(resolve(root, registry.reusableAssetRegistryPath), "utf8");
    for (const entry of entries.values()) {
      if (["BASE", "CAPABILITY"].includes(entry.layer)) {
        const escapedName = entry.name.replaceAll("-", "\\-");
        if (!humanRegistry.includes(`|${entry.name}|`) && !humanRegistry.includes(`|${escapedName}|`)) {
          if (entry.status !== "DEPRECATED") throw new Error(`Figma Prompt ${entry.id} is missing from the human Registry`);
        }
      }
    }
    this.loaded = { root, entries, humanRegistry, reusableAssetRegistry };
    return this.loaded;
  }

  async readPrompt(id: string): Promise<LoadedFigmaPrompt> {
    const catalog = await this.initialize();
    const entry = catalog.entries.get(id);
    if (!entry) throw new Error(`Unknown Figma Prompt ID: ${id}`);
    if (!entry.path) throw new Error(`Figma Prompt ${id} has no file`);
    const content = await readFile(resolve(catalog.root, entry.path), "utf8");
    return { entry, content, hash: createHash("sha256").update(content).digest("hex") };
  }

  async humanRegistry(): Promise<string> {
    return (await this.initialize()).humanRegistry;
  }

  async reusableAssetRegistry(): Promise<string> {
    return (await this.initialize()).reusableAssetRegistry;
  }

  async metaRegistryView(): Promise<Array<Record<string, unknown>>> {
    const { entries } = await this.initialize();
    return [...entries.values()]
      .filter(entry => entry.layer === "BASE" || entry.layer === "CAPABILITY")
      .map(entry => ({
        id: entry.id,
        name: entry.name,
        layer: entry.layer,
        capabilityType: entry.capabilityType,
        status: entry.status,
        dependencies: entry.dependencies,
        selectable: entry.selectable
      }));
  }

  async validateSelection(selection: FigmaPromptSelection): Promise<void> {
    const { entries } = await this.initialize();
    const groups: Array<[string, string[], FigmaPromptEntry["layer"], FigmaPromptEntry["capabilityType"]?]> = [
      ["base", [selection.baseId], "BASE"],
      ["domain", selection.domainCapabilityIds, "CAPABILITY", "DOMAIN"],
      ["support", selection.supportCapabilityIds, "CAPABILITY", "SUPPORT"]
    ];
    const ids = groups.flatMap(([, values]) => values);
    if (new Set(ids).size !== ids.length) throw new Error("Figma Prompt selection contains duplicate IDs");
    for (const [group, groupIds, layer, capabilityType] of groups) {
      for (const id of groupIds) {
        const entry = entries.get(id);
        if (!entry) throw new Error(`Meta selected unknown Figma Prompt ID: ${id}`);
        if (entry.layer !== layer || (capabilityType && entry.capabilityType !== capabilityType)) {
          throw new Error(`Meta selected ${id} in the wrong ${group} group`);
        }
        if (entry.status !== "STABLE" || !entry.selectable || !entry.path) {
          throw new Error(`Meta selected non-executable Figma Prompt: ${id}`);
        }
      }
    }
  }

  async orderedSelection(selection: FigmaPromptSelection): Promise<LoadedFigmaPrompt[]> {
    await this.validateSelection(selection);
    const requested = [selection.baseId, ...selection.domainCapabilityIds, ...selection.supportCapabilityIds];
    const catalog = await this.initialize();
    const ordered: LoadedFigmaPrompt[] = [];
    const visited = new Set<string>();
    const visit = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      const entry = catalog.entries.get(id);
      if (!entry) throw new Error(`Unknown Figma Prompt dependency: ${id}`);
      for (const dependency of entry.dependencies) await visit(dependency);
      if (entry.layer === "BASE" || entry.layer === "CAPABILITY") {
        if (entry.status !== "STABLE" || !entry.path) throw new Error(`Dependency ${id} is not executable`);
        ordered.push(await this.readPrompt(id));
      }
      visited.add(id);
    };
    for (const id of requested) await visit(id);
    return ordered;
  }
}

