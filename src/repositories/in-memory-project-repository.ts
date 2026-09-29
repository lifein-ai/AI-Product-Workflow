import type { ProjectRecord } from "../domain/types.js";
import type { ProjectRepository } from "./project-repository.js";

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly store = new Map<string, ProjectRecord>();

  async create(project: ProjectRecord): Promise<ProjectRecord> {
    if (this.store.has(project.id)) throw new Error("Project already exists");
    this.store.set(project.id, structuredClone(project));
    return structuredClone(project);
  }

  async getById(id: string): Promise<ProjectRecord | null> {
    const project = this.store.get(id);
    return project ? structuredClone(project) : null;
  }

  async list(): Promise<ProjectRecord[]> {
    return [...this.store.values()].map(project => structuredClone(project));
  }

  async save(project: ProjectRecord): Promise<void> {
    const current = this.store.get(project.id);
    if (!current) throw new Error("Project not found");
    if (current.recordVersion !== project.recordVersion) throw new Error("Project changed concurrently");
    project.recordVersion += 1;
    this.store.set(project.id, structuredClone(project));
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async storageInfo(id: string) {
    const project = this.store.get(id);
    return project
      ? { kind: "memory" as const, recordName: `memory:${id}`, bytes: Buffer.byteLength(JSON.stringify(project), "utf8") }
      : null;
  }
}
