import type { ProjectRecord } from "../domain/types.js";

export interface ProjectStorageInfo {
  kind: "memory" | "file";
  recordName: string;
  bytes: number;
}

export interface ProjectRepository {
  create(project: ProjectRecord): Promise<ProjectRecord>;
  getById(id: string): Promise<ProjectRecord | null>;
  list(): Promise<ProjectRecord[]>;
  save(project: ProjectRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  storageInfo(id: string): Promise<ProjectStorageInfo | null>;
}
