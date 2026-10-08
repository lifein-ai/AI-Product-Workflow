export interface ProjectDeletionTarget {
  id: string;
  name: string;
}

export interface ProjectDeletionResult {
  deleted: boolean;
  wasActive: boolean;
}

export interface ProjectDeletionController {
  wasDeleted(projectId: string): boolean;
  excludeDeletedProjects<T extends { id: string }>(projects: T[]): T[];
  deleteProject(project: ProjectDeletionTarget): Promise<ProjectDeletionResult>;
}

export function createProjectDeletionController(options: {
  confirmDelete: (message: string) => boolean;
  deleteById: (projectId: string) => Promise<void>;
  getActiveProjectId: () => string | null;
  clearActiveProject: () => void;
  removeProjectFromHistory: (projectId: string) => void;
  refreshProjects: () => Promise<void>;
  onConfirmed?: () => void;
  onSettled?: () => void;
}): ProjectDeletionController;
