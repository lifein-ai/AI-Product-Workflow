import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProjectRecord } from "../domain/types.js";
import { emptyFigmaPromptArtifact, emptyInteractionArtifact, emptyPrdArtifact } from "../domain/factories.js";
import type { ProjectRepository, ProjectStorageInfo } from "./project-repository.js";

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeProject(value: ProjectRecord): ProjectRecord {
  const timestamp = value.productSpec?.project?.updatedAt ?? new Date().toISOString();
  value.artifacts ??= {
    prd: emptyPrdArtifact(timestamp),
    interaction: emptyInteractionArtifact(timestamp),
    figmaPrompt: emptyFigmaPromptArtifact(timestamp)
  };
  value.artifacts.prd ??= emptyPrdArtifact(timestamp);
  value.artifacts.interaction ??= emptyInteractionArtifact(timestamp);
  value.artifacts.figmaPrompt ??= emptyFigmaPromptArtifact(timestamp);
  value.artifacts.prd.contentRevision ??= 0;
  value.artifacts.prd.clarifications ??= [];
  value.artifacts.interaction.contentRevision ??= 0;
  value.artifacts.interaction.openQuestions ??= [];
  value.artifacts.interaction.clarifications ??= [];
  value.artifacts.interaction.generationNotes ??= [];
  value.artifacts.interaction.blockingIssues ??= [];
  value.artifacts.figmaPrompt.contentRevision ??= 0;
  const legacyTimestamp = value.productSpec.version?.updatedAt ?? timestamp;
  for (const decision of value.productSpec.decisions ?? []) {
    decision.source ??= { type: "LEGACY" };
    decision.createdAt ??= legacyTimestamp;
    decision.updatedAt ??= legacyTimestamp;
    decision.projectId ??= value.id;
    decision.feature ??= decision.stage;
    decision.topic ??= decision.decision;
    decision.reason ??= decision.rationale?.join(" · ") || null;
    decision.alternatives ??= [];
    decision.importance ??= 2;
    decision.strength ??= "EXPLICIT";
    decision.sourceMessageIds ??= decision.source?.messageId ? [decision.source.messageId] : [];
    decision.history ??= [];
  }
  for (const question of value.productSpec.openQuestions ?? []) question.source ??= { type: "LEGACY" };
  if (value.artifacts.figmaPrompt.lifecycleStatus === "CURRENT" && value.artifacts.interaction.lifecycleStatus !== "CURRENT") {
    value.artifacts.figmaPrompt.lifecycleStatus = "STALE";
    value.artifacts.figmaPrompt.updatedAt = timestamp;
  }
  value.messages ??= [];
  value.decisionMemory ??= { status: "IDLE" };
  return value;
}

export class FileProjectRepository implements ProjectRepository {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly rootDirectory = process.env.WORKFLOW_DATA_DIR
    ? resolve(process.env.WORKFLOW_DATA_DIR)
    : resolve(process.cwd(), ".runtime", "projects")) {}

  async create(project: ProjectRecord): Promise<ProjectRecord> {
    return this.withLock(project.id, async () => {
      await this.ensureRoot();
      if (await this.getById(project.id)) throw new Error("Project already exists");
      await this.writeAtomic(project);
      return structuredClone(project);
    });
  }

  async getById(id: string): Promise<ProjectRecord | null> {
    const path = this.projectPath(id);
    try {
      const content = await readFile(path, "utf8");
      return normalizeProject(JSON.parse(content) as ProjectRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(): Promise<ProjectRecord[]> {
    await this.ensureRoot();
    const files = (await readdir(this.rootDirectory)).filter(file => file.endsWith(".json") && PROJECT_ID.test(file.slice(0, -5)));
    const projects = await Promise.all(files.map(file => this.getById(file.slice(0, -5))));
    return projects.filter((project): project is ProjectRecord => project !== null);
  }

  async save(project: ProjectRecord): Promise<void> {
    await this.withLock(project.id, async () => {
      const current = await this.getById(project.id);
      if (!current) throw new Error("Project not found");
      if (current.recordVersion !== project.recordVersion) throw new Error("Project changed concurrently");
      project.recordVersion += 1;
      await this.writeAtomic(project);
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.withLock(id, async () => {
      try {
        await unlink(this.projectPath(id));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
  }

  async storageInfo(id: string): Promise<ProjectStorageInfo | null> {
    try {
      const info = await stat(this.projectPath(id));
      return { kind: "file", recordName: `${id}.json`, bytes: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private projectPath(id: string) {
    if (!PROJECT_ID.test(id)) throw new Error("Invalid project id");
    return resolve(this.rootDirectory, `${id}.json`);
  }

  private async ensureRoot() {
    await mkdir(this.rootDirectory, { recursive: true });
  }

  private async writeAtomic(project: ProjectRecord) {
    await this.ensureRoot();
    const target = this.projectPath(project.id);
    const temporary = resolve(this.rootDirectory, `.${project.id}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private async withLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolveLock => { release = resolveLock; });
    const queued = previous.then(() => current);
    this.locks.set(id, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(id) === queued) this.locks.delete(id);
    }
  }
}
