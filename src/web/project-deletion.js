export function createProjectDeletionController({
  confirmDelete,
  deleteById,
  getActiveProjectId,
  clearActiveProject,
  removeProjectFromHistory,
  refreshProjects,
  onConfirmed = () => {},
  onSettled = () => {}
}) {
  const deletedProjectIds = new Set();

  return {
    wasDeleted(projectId) {
      return deletedProjectIds.has(projectId);
    },

    excludeDeletedProjects(projects) {
      return projects.filter(project => !deletedProjectIds.has(project.id));
    },

    async deleteProject(project) {
      const confirmed = confirmDelete(
        `Delete “${project.name}” and its generated artifacts from local storage? Export first if you need a backup.`
      );
      if (!confirmed) return { deleted: false, wasActive: false };

      onConfirmed();
      try {
        await deleteById(project.id);
        deletedProjectIds.add(project.id);

        const wasActive = getActiveProjectId() === project.id;
        removeProjectFromHistory(project.id);
        if (wasActive) clearActiveProject();
        await refreshProjects();

        return { deleted: true, wasActive };
      } finally {
        onSettled();
      }
    }
  };
}
