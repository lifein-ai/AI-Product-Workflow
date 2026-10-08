import { createSubmissionGuard } from "/submission-guard.js";
import { createProjectDeletionController } from "/project-deletion.js";
import { createRequestHeaders } from "/http-client.js";

const submissionGuard = createSubmissionGuard({
  log(event, detail) {
    console.info(`[discovery-request] ${event}`, detail);
  }
});

const ui = Object.fromEntries([
  "workspace-title", "conversation-title", "spec-title", "readiness-title", "decisions-title",
  "workflow-progress", "stage-step-discovery", "stage-step-solution", "stage-step-prd", "stage-step-interaction", "stage-step-figma",
  "interaction-mode", "manual-bridge-panel", "manual-bridge-title", "manual-bridge-step",
  "manual-bridge-prompt", "copy-manual-bridge-prompt", "manual-bridge-copy-status",
  "manual-bridge-response", "cancel-manual-bridge", "apply-manual-bridge",
  "provider-summary", "provider-settings-button", "provider-dialog", "provider-dialog-close",
  "provider-library-error", "provider-current-name", "provider-current-model", "provider-profile-list",
  "decision-provider-profile", "decision-provider-model", "save-decision-provider",
  "provider-form", "provider-form-title", "provider-form-cancel", "provider-edit-id", "provider-name-input",
  "provider-base-url-input", "provider-api-key-input", "provider-models-input", "provider-default-model-input",
  "provider-save-button",
  "projects-button", "new-project-button", "reload-projects-button", "project-history-summary", "project-list",
  "revision-badge", "status-badge", "project-name", "create-view", "create-form", "project-name-input",
  "initial-requirement", "create-button", "conversation-view", "conversation-scroll", "initial-requirement-card", "messages",
  "activity", "activity-title", "activity-detail", "revision-notice", "error-panel", "error-message",
  "error-title", "retry-button", "refresh-button", "confirmation-panel", "confirmation-title", "confirmation-description",
  "confirm-button", "confirmed-panel", "confirmed-title", "confirmed-description", "start-solution-button",
  "generate-prd-button", "continue-interaction-button", "prd-panel", "prd-status", "prd-blocking",
  "reopen-stage-button", "reopen-discovery-button", "copy-prd-button", "copy-interaction-button",
  "prd-clarification-wrap", "prd-clarification-answer", "submit-prd-clarification-button", "return-to-solution-button",
  "prd-content", "prd-source", "save-prd-button", "confirm-prd-button", "message-form", "message-input-label",
  "interaction-panel", "interaction-status", "interaction-blocking", "interaction-clarification-wrap",
  "interaction-clarification-answer", "submit-interaction-clarification-button", "interaction-content",
  "interaction-source", "generate-interaction-button", "save-interaction-button", "confirm-interaction-button",
  "figma-prompt-panel", "figma-prompt-status", "figma-prompt-blocking", "figma-prompt-content",
  "figma-prompt-source", "generate-figma-prompt-button", "save-figma-prompt-button",
  "copy-figma-prompt-button", "confirm-figma-prompt-button",
  "message-input", "send-button", "spec-revision", "readiness-status", "readiness-reasons", "spec-content",
  "blocking-count", "blocking-questions", "nonblocking-count", "nonblocking-questions", "active-decisions",
  "decision-search", "scan-decisions-button", "decision-scan-status", "deferred-decisions-wrap", "deferred-count", "deferred-decisions",
  "superseded-decisions-wrap", "superseded-count", "superseded-decisions", "project-storage-section",
  "storage-kind", "manage-project-name", "rename-project-button", "project-record-detail", "export-project-button",
  "prd-file-detail", "clear-prd-button", "interaction-file-detail", "clear-interaction-button",
  "figma-file-detail", "clear-figma-button", "cleanup-artifacts-button",
  "delete-project-button"
].map(id => [id, document.getElementById(id)]));

const state = {
  project: null,
  projects: [],
  busy: false,
  pendingMessage: "",
  lastFailedMessage: "",
  retryAllowed: false,
  elapsedStartedAt: 0,
  elapsedTimer: null,
  requestProgressTimer: null,
  activeRequestId: "",
  requestProgress: null,
  providerLibrary: null,
  providerBusy: false,
  interactionMode: window.localStorage.getItem("workflowInteractionMode") === "manual" ? "manual" : "provider",
  manualBridgeTurn: null,
  manualBridgeResponse: "",
  dirtyArtifacts: new Set(),
  notice: ""
};

function isManualBridgeMode() {
  return state.interactionMode === "manual";
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: createRequestHeaders(options)
    });
  } catch (error) {
    throw new Error("无法连接服务器。请先刷新服务器状态，确认消息是否已保存，再决定是否重新发送。", { cause: error });
  }
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error || `Request failed with HTTP ${response.status}`;
    throw new ApiError(friendlyError(message, response.status), response.status);
  }
  return body;
}

function friendlyError(message, status) {
  if (status === 504) return "AI 响应超时，本轮没有保存。可以安全重试这条消息。";
  if (status === 502 && /validation/i.test(message)) return "AI 返回结果连续两次未通过工作流校验，本轮没有保存。可以安全重试；若持续出现请检查 Runtime 日志。";
  if (status === 502 && /output token limit/i.test(message)) return "AI 输出超过当前长度限制，本轮没有保存。请提高服务端输出上限后安全重试。";
  if (status === 502 && /compatibility/i.test(message)) return "ModelFlare 暂时无法接受本次请求，本轮没有保存。可以安全重试。";
  if (status === 502) return `无法连接 ${activeProviderName()}，本轮没有保存。请检查网络或服务状态后安全重试。`;
  if (status === 503) return `${activeProviderName()} 当前不可用，请检查 AI Settings 后重试。`;
  if (status === 409) return `服务器状态已变化：${message}。请刷新后继续。`;
  return message;
}

function activeProviderName() {
  return state.providerLibrary?.active?.name || "AI Provider";
}

function setBusy(busy, title = "Discovery is working") {
  state.busy = busy;
  ui.activity.hidden = !busy;
  ui["activity-title"].textContent = title;
  ui["create-button"].disabled = busy;
  ui["send-button"].disabled = busy;
  ui["confirm-button"].disabled = busy;
  ui["start-solution-button"].disabled = busy;
  ui["reopen-stage-button"].disabled = busy;
  ui["reopen-discovery-button"].disabled = busy;
  ui["generate-prd-button"].disabled = busy;
  ui["submit-prd-clarification-button"].disabled = busy;
  ui["return-to-solution-button"].disabled = busy;
  ui["prd-clarification-answer"].disabled = busy;
  ui["save-prd-button"].disabled = busy;
  ui["copy-prd-button"].disabled = busy;
  ui["confirm-prd-button"].disabled = busy;
  ui["prd-content"].disabled = busy;
  ui["generate-interaction-button"].disabled = busy;
  ui["save-interaction-button"].disabled = busy;
  ui["copy-interaction-button"].disabled = busy;
  ui["confirm-interaction-button"].disabled = busy;
  ui["submit-interaction-clarification-button"].disabled = busy;
  ui["interaction-clarification-answer"].disabled = busy;
  ui["interaction-content"].disabled = busy;
  ui["generate-figma-prompt-button"].disabled = busy;
  ui["save-figma-prompt-button"].disabled = busy;
  ui["copy-figma-prompt-button"].disabled = busy;
  ui["confirm-figma-prompt-button"].disabled = busy;
  ui["figma-prompt-content"].disabled = busy;
  ui["projects-button"].disabled = busy;
  ui["new-project-button"].disabled = busy;
  ui["reload-projects-button"].disabled = busy;
  ui["provider-settings-button"].disabled = busy;
  ui["interaction-mode"].disabled = busy || Boolean(state.manualBridgeTurn);
  ui["copy-manual-bridge-prompt"].disabled = busy;
  ui["manual-bridge-response"].disabled = busy;
  ui["cancel-manual-bridge"].disabled = busy;
  ui["apply-manual-bridge"].disabled = busy;
  ui["rename-project-button"].disabled = busy;
  ui["export-project-button"].disabled = busy;
  ui["clear-prd-button"].disabled = busy;
  ui["clear-interaction-button"].disabled = busy;
  ui["clear-figma-button"].disabled = busy;
  ui["cleanup-artifacts-button"].disabled = busy;
  ui["scan-decisions-button"].disabled = busy || !state.project;
  ui["delete-project-button"].disabled = busy;
  for (const button of document.querySelectorAll(".project-card-actions button")) button.disabled = busy;
  ui["message-input"].disabled = busy || stageStatus() === "CONFIRMED";
  if (busy) {
    state.elapsedStartedAt = Date.now();
    updateElapsed();
    state.elapsedTimer = window.setInterval(updateElapsed, 1000);
  } else if (state.elapsedTimer) {
    window.clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }
}

function updateElapsed() {
  const seconds = Math.floor((Date.now() - state.elapsedStartedAt) / 1000);
  const expectation = state.requestProgress?.detail || (seconds < 30
    ? "Preparing context and reviewing the requirement."
    : seconds < 60
      ? `${activeProviderName()} is still working. This response time is expected.`
      : "Still working — tool calling can take several minutes. You can keep this page open.");
  ui["activity-detail"].textContent = `${expectation} ${seconds}s elapsed.`;
}

function beginRequestProgress(requestId) {
  endRequestProgress();
  state.activeRequestId = requestId;
  state.requestProgress = null;
  void pollRequestProgress();
  state.requestProgressTimer = window.setInterval(() => void pollRequestProgress(), 2000);
}

function endRequestProgress() {
  if (state.requestProgressTimer) window.clearInterval(state.requestProgressTimer);
  state.requestProgressTimer = null;
  state.activeRequestId = "";
}

async function pollRequestProgress() {
  const requestId = state.activeRequestId;
  if (!requestId) return;
  try {
    const response = await fetch(`/requests/${encodeURIComponent(requestId)}`);
    if (!response.ok) return;
    const progress = await response.json();
    if (state.activeRequestId !== requestId) return;
    state.requestProgress = progress;
    updateElapsed();
  } catch {
    // The primary request remains authoritative. Progress polling is best effort only.
  }
}

function activeStage() {
  if (!state.project) return "DISCOVERY";
  const explicitStage = state.project?.workflow?.activeStage;
  if (explicitStage) return explicitStage;

  return state.project?.workflow?.stages?.SOLUTION?.status !== "NOT_STARTED"
    ? "SOLUTION"
    : "DISCOVERY";
}

function stageStatus() {
  return state.project?.workflow?.stages?.[activeStage()]?.status || "NOT_STARTED";
}

function stageName() {
  return activeStage() === "SOLUTION" ? "Product Solution" : "Discovery";
}

function displayStatus() {
  return stageStatus() === "CONFIRMED" ? `${activeStage()}_CONFIRMED` : stageStatus();
}

function render() {
  const hasProject = Boolean(state.project);
  ui["interaction-mode"].value = state.interactionMode;
  ui["interaction-mode"].disabled = state.busy || Boolean(state.manualBridgeTurn);
  ui["scan-decisions-button"].disabled = state.busy || !hasProject;
  ui["workflow-progress"].hidden = !hasProject;
  ui["create-view"].hidden = hasProject;
  ui["conversation-view"].hidden = !hasProject;
  ui["project-name"].textContent = hasProject ? state.project.productSpec.project.name : "";
  ui["revision-badge"].textContent = hasProject ? `Revision ${state.project.productSpec.version.revision}` : "No project";
  ui["spec-revision"].textContent = hasProject ? `Revision ${state.project.productSpec.version.revision}` : "Revision —";
  ui["status-badge"].textContent = displayStatus();
  ui["status-badge"].className = `status-badge ${statusClass()}`;
  const currentName = stageName();
  ui["workspace-title"].textContent = `${currentName} Workspace`;
  ui["conversation-title"].textContent = `${currentName} Conversation`;
  ui["spec-title"].textContent = activeStage() === "SOLUTION" ? "Current Product Solution" : "Live Product Spec";
  ui["readiness-title"].textContent = `${currentName} Status`;
  ui["decisions-title"].textContent = "Decision Memory";
  ui["message-input-label"].textContent = activeStage() === "SOLUTION" ? "Discuss or refine the solution" : "Your answer";
  ui["send-button"].textContent = isManualBridgeMode() ? "Create ChatGPT Prompt" : "Send Answer";
  ui["error-title"].textContent = `${currentName} request failed`;

  renderProjectHistory();
  renderProjectStorage();
  renderWorkflowProgress();

  renderReadiness();
  renderSpec();
  renderQuestions();
  renderDecisions();

  if (!hasProject) return;
  const handoff = activeStage() === "SOLUTION" ? discoveryHandoffSummary() : state.project.productSpec.project.initialRequirement;
  ui["initial-requirement-card"].dataset.label = activeStage() === "SOLUTION" ? "Confirmed Discovery Handoff" : "Initial Requirement";
  ui["initial-requirement-card"].textContent = handoff;
  renderMessages();
  renderManualBridge();
  ui["revision-notice"].hidden = !state.notice;
  ui["revision-notice"].textContent = state.notice;
  ui["confirmation-panel"].hidden = stageStatus() !== "READY_FOR_CONFIRMATION";
  ui["confirmation-title"].textContent = `${currentName} is sufficient to proceed.`;
  ui["confirmation-description"].textContent = `The AI has prepared the ${currentName}. Only you can confirm it.`;
  ui["confirm-button"].textContent = `Confirm ${currentName}`;
  ui["confirm-button"].disabled = state.busy || Boolean(state.manualBridgeTurn);
  ui["confirmed-panel"].hidden = stageStatus() !== "CONFIRMED";
  ui["confirmed-title"].textContent = `${activeStage()}_CONFIRMED`;
  ui["confirmed-description"].textContent = `${currentName} is frozen at the confirmed content version.`;
  ui["start-solution-button"].hidden = !(activeStage() === "DISCOVERY" && stageStatus() === "CONFIRMED" && state.project.workflow.stages.SOLUTION.status === "NOT_STARTED");
  ui["start-solution-button"].disabled = state.busy || Boolean(state.manualBridgeTurn);
  ui["reopen-stage-button"].hidden = stageStatus() !== "CONFIRMED";
  ui["reopen-stage-button"].textContent = `Reopen ${currentName}`;
  ui["reopen-discovery-button"].hidden = !(activeStage() === "SOLUTION" && state.project.workflow.stages.DISCOVERY.status === "CONFIRMED");
  renderPrdArtifact();
  renderInteractionArtifact();
  renderFigmaPromptArtifact();
  ui["message-form"].hidden = stageStatus() === "CONFIRMED" || Boolean(state.manualBridgeTurn);
  ui["message-input"].disabled = state.busy || stageStatus() === "CONFIRMED" || Boolean(state.manualBridgeTurn);
  ui["message-input"].placeholder = activeStage() === "SOLUTION" ? "修改、否定或补充当前 Product Solution…" : "Answer the current Discovery question…";
}

function renderWorkflowProgress() {
  if (!state.project) return;
  const steps = [
    ["stage-step-discovery", state.project.workflow.stages.DISCOVERY.status],
    ["stage-step-solution", state.project.workflow.stages.SOLUTION.status],
    ["stage-step-prd", state.project.artifacts.prd.reviewStatus],
    ["stage-step-interaction", state.project.artifacts.interaction.reviewStatus],
    ["stage-step-figma", state.project.artifacts.figmaPrompt.reviewStatus]
  ];
  for (const [id, status] of steps) {
    ui[id].className = status === "CONFIRMED" ? "complete" : ["IN_PROGRESS", "READY_FOR_CONFIRMATION", "DRAFT", "BLOCKED"].includes(status) ? "current" : "";
  }
}

function renderManualBridge() {
  const turn = state.manualBridgeTurn;
  ui["manual-bridge-panel"].hidden = !turn;
  if (!turn) return;
  ui["manual-bridge-title"].textContent = turn.kind === "SOLUTION_START"
    ? "Start Product Solution in ChatGPT"
    : `Continue this ${stageName()} turn in ChatGPT`;
  ui["manual-bridge-step"].textContent = state.manualBridgeResponse.trim() ? "2 · Apply response" : "1 · Copy prompt";
  ui["manual-bridge-prompt"].value = turn.prompt;
  if (ui["manual-bridge-response"].value !== state.manualBridgeResponse) {
    ui["manual-bridge-response"].value = state.manualBridgeResponse;
  }
  ui["apply-manual-bridge"].disabled = state.busy || !state.manualBridgeResponse.trim();
}

function renderProjectHistory() {
  ui["project-list"].replaceChildren();
  ui["project-history-summary"].textContent = state.projects.length === 0
    ? "No saved projects yet. New projects are persisted automatically."
    : `${state.projects.length} saved project${state.projects.length === 1 ? "" : "s"}, newest activity first.`;
  for (const project of state.projects) {
    const card = node("article", "project-card");
    const copy = node("div", "project-card-copy");
    copy.append(node("h4", "", project.name));
    copy.append(node("p", "project-card-requirement", project.initialRequirement));
    const statuses = `Discovery ${project.stageStatuses.DISCOVERY} · Solution ${project.stageStatuses.SOLUTION} · PRD ${project.artifacts.prd.lifecycleStatus} · Interaction ${project.artifacts.interaction.lifecycleStatus} · Figma ${project.artifacts.figmaPrompt.lifecycleStatus}`;
    copy.append(node("p", "project-card-meta", `${formatDate(project.updatedAt)} · ${statuses}`));
    const actions = node("div", "project-card-actions");
    const open = node("button", "primary-button compact-button", "Open conversation");
    open.type = "button";
    open.addEventListener("click", () => void openProject(project.id));
    const rename = node("button", "secondary-button compact-button", "Rename");
    rename.type = "button";
    rename.addEventListener("click", () => void renameSavedProject(project));
    const remove = node("button", "secondary-button compact-button destructive-button", "Delete");
    remove.type = "button";
    remove.addEventListener("click", () => void deleteSavedProject(project));
    actions.append(open, rename, remove);
    card.append(copy, actions);
    ui["project-list"].append(card);
  }
}

function renderProjectStorage() {
  const project = state.project;
  ui["project-storage-section"].hidden = !project;
  if (!project) return;
  const summary = state.projects.find(item => item.id === project.id);
  const storage = summary?.storage;
  ui["storage-kind"].textContent = storage?.kind === "file" ? "LOCAL FILE" : "LOCAL";
  ui["manage-project-name"].value = project.productSpec.project.name;
  ui["project-record-detail"].textContent = storage ? `${storage.recordName} · ${formatBytes(storage.bytes)}` : "Saved project record";
  const prd = project.artifacts.prd;
  const interaction = project.artifacts.interaction;
  const figma = project.artifacts.figmaPrompt;
  ui["prd-file-detail"].textContent = `${prd.lifecycleStatus} · ${prd.reviewStatus} · ${formatBytes(new Blob([prd.currentContent || ""]).size)}`;
  ui["interaction-file-detail"].textContent = `${interaction.lifecycleStatus} · ${interaction.reviewStatus} · ${formatBytes(new Blob([interaction.currentContent || ""]).size)}`;
  ui["figma-file-detail"].textContent = `${figma.lifecycleStatus} · ${figma.reviewStatus} · ${formatBytes(new Blob([figma.currentContent || ""]).size)}`;
  ui["clear-prd-button"].disabled = state.busy || prd.lifecycleStatus === "NOT_GENERATED";
  ui["clear-interaction-button"].disabled = state.busy || interaction.lifecycleStatus === "NOT_GENERATED";
  ui["clear-figma-button"].disabled = state.busy || figma.lifecycleStatus === "NOT_GENERATED";
  const disposable = [prd, interaction, figma].some(item => item.lifecycleStatus === "STALE" || item.lifecycleStatus === "FAILED" || item.reviewStatus === "BLOCKED");
  ui["cleanup-artifacts-button"].disabled = state.busy || !disposable;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function loadProjectHistory() {
  const result = await api("/projects");
  state.projects = projectDeletion.excludeDeletedProjects(result.projects || []);
  renderProjectHistory();
  renderProjectStorage();
}

async function openProject(projectId) {
  if (state.busy) return;
  clearError();
  try {
    const project = await api(`/projects/${encodeURIComponent(projectId)}`);
    if (projectDeletion.wasDeleted(projectId)) return;
    clearManualBridgeTurn();
    state.dirtyArtifacts.clear();
    state.project = project;
    window.localStorage.setItem("discoveryProjectId", state.project.id);
    window.history.replaceState(null, "", `/?project=${encodeURIComponent(state.project.id)}`);
    state.notice = "Saved project restored from local storage.";
    render();
  } catch (error) {
    showError(error);
    render();
  }
}

async function renameSavedProject(project) {
  if (state.busy) return;
  const name = window.prompt("Rename project", project.name)?.trim();
  if (!name || name === project.name) return;
  setBusy(true, "Renaming project");
  try {
    await api(`/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
    await loadProjectHistory();
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
}

async function deleteSavedProject(project) {
  if (state.busy) return;
  try {
    await projectDeletion.deleteProject(project);
  } catch (error) {
    showError(error);
  } finally {
    render();
  }
}

function renderPrdArtifact() {
  const solutionConfirmed = state.project?.workflow?.stages?.SOLUTION?.status === "CONFIRMED";
  const artifact = state.project?.artifacts?.prd;
  const hasArtifactState = artifact && artifact.reviewStatus !== "NOT_STARTED";
  const canClarify = artifact?.lifecycleStatus === "NOT_GENERATED" && artifact?.reviewStatus === "BLOCKED" &&
    (artifact?.openQuestions || []).length > 0 && !(artifact?.openQuestions || []).some(question => question.scope === "PRODUCT_DECISION");
  ui["prd-panel"].hidden = !solutionConfirmed && !hasArtifactState;
  ui["generate-prd-button"].hidden = !solutionConfirmed || canClarify || artifact?.lifecycleStatus === "CURRENT";
  ui["generate-prd-button"].textContent = "Generate PRD Requirement Details";
  ui["continue-interaction-button"].hidden = true;
  if (!artifact) return;

  ui["prd-status"].textContent = `${artifact.lifecycleStatus} · ${artifact.reviewStatus}`;
  ui["prd-status"].className = `status-badge ${artifact.reviewStatus === "CONFIRMED" ? "status-confirmed" : artifact.reviewStatus === "BLOCKED" || artifact.lifecycleStatus === "STALE" ? "status-ready" : ""}`;
  if (!state.dirtyArtifacts.has("prd")) ui["prd-content"].value = artifact.currentContent || artifact.generatedContent || "";
  ui["prd-content"].readOnly = artifact.lifecycleStatus !== "CURRENT";
  ui["save-prd-button"].hidden = artifact.lifecycleStatus !== "CURRENT";
  ui["copy-prd-button"].hidden = !artifact.currentContent;
  ui["confirm-prd-button"].hidden = artifact.lifecycleStatus !== "CURRENT" || artifact.reviewStatus !== "DRAFT";
  const versions = artifact.sourceVersions;
  ui["prd-source"].textContent = versions ? `Source Discovery v${versions.discovery} · Solution v${versions.solution}` : "";
  const issues = [...(artifact.blockingIssues || []), ...(artifact.openQuestions || []).map(item => `${item.question} — ${item.impact}`)];
  ui["prd-blocking"].hidden = issues.length === 0;
  ui["prd-blocking"].textContent = [...new Set(issues)].join("\n");
  ui["return-to-solution-button"].hidden = !(artifact.reviewStatus === "BLOCKED" && state.project.workflow.stages.SOLUTION.status === "CONFIRMED");
  ui["prd-clarification-wrap"].hidden = !canClarify;
}

function renderInteractionArtifact() {
  const prd = state.project?.artifacts?.prd;
  const artifact = state.project?.artifacts?.interaction;
  const eligible = prd?.lifecycleStatus === "CURRENT" && prd?.reviewStatus === "CONFIRMED";
  const hasArtifactState = artifact && artifact.reviewStatus !== "NOT_STARTED";
  const canClarify = artifact?.lifecycleStatus === "NOT_GENERATED" && artifact?.reviewStatus === "BLOCKED" &&
    (artifact?.openQuestions || []).length > 0 && !(artifact?.openQuestions || []).some(question => question.scope === "PRODUCT_DECISION");
  ui["interaction-panel"].hidden = !eligible && !hasArtifactState;
  ui["continue-interaction-button"].hidden = true;
  ui["continue-interaction-button"].disabled = state.busy;
  if (!artifact) return;
  ui["interaction-status"].textContent = `${artifact.lifecycleStatus} · ${artifact.reviewStatus}`;
  ui["interaction-status"].className = `status-badge ${artifact.reviewStatus === "CONFIRMED" ? "status-confirmed" : artifact.reviewStatus === "BLOCKED" || artifact.lifecycleStatus === "STALE" ? "status-ready" : ""}`;
  if (!state.dirtyArtifacts.has("interaction")) ui["interaction-content"].value = artifact.currentContent || artifact.generatedContent || "";
  ui["interaction-content"].readOnly = artifact.lifecycleStatus !== "CURRENT";
  ui["generate-interaction-button"].hidden = !eligible || canClarify || artifact.lifecycleStatus === "CURRENT";
  ui["generate-interaction-button"].textContent = "Generate Interaction Specification";
  ui["save-interaction-button"].hidden = artifact.lifecycleStatus !== "CURRENT";
  ui["copy-interaction-button"].hidden = !artifact.currentContent;
  ui["confirm-interaction-button"].hidden = artifact.lifecycleStatus !== "CURRENT" || artifact.reviewStatus !== "DRAFT";
  const versions = artifact.sourceVersions;
  ui["interaction-source"].textContent = versions ? `Product State v${versions.confirmedProductStateVersion} · PRD v${versions.prd}` : "";
  const issues = [...(artifact.blockingIssues || []), ...(artifact.openQuestions || []).map(item => `${item.question} — ${item.impact}`)];
  ui["interaction-blocking"].hidden = issues.length === 0;
  ui["interaction-blocking"].textContent = [...new Set(issues)].join("\n");
  ui["interaction-clarification-wrap"].hidden = !canClarify;
}

function renderFigmaPromptArtifact() {
  const interaction = state.project?.artifacts?.interaction;
  const artifact = state.project?.artifacts?.figmaPrompt;
  const eligible = interaction?.lifecycleStatus === "CURRENT" && interaction?.reviewStatus === "CONFIRMED";
  const hasArtifactState = artifact && artifact.reviewStatus !== "NOT_STARTED";
  ui["figma-prompt-panel"].hidden = !eligible && !hasArtifactState;
  if (!artifact) return;

  ui["figma-prompt-status"].textContent = `${artifact.lifecycleStatus} · ${artifact.reviewStatus}`;
  ui["figma-prompt-status"].className = `status-badge ${artifact.reviewStatus === "CONFIRMED" ? "status-confirmed" : artifact.reviewStatus === "BLOCKED" || artifact.lifecycleStatus === "STALE" ? "status-ready" : ""}`;
  if (!state.dirtyArtifacts.has("figma")) ui["figma-prompt-content"].value = artifact.currentContent || artifact.generatedContent || "";
  ui["figma-prompt-content"].readOnly = artifact.lifecycleStatus !== "CURRENT";
  ui["generate-figma-prompt-button"].hidden = !eligible || artifact.lifecycleStatus === "CURRENT";
  ui["generate-figma-prompt-button"].textContent = "Assemble Codex Figma Prompt";
  ui["save-figma-prompt-button"].hidden = artifact.lifecycleStatus !== "CURRENT";
  ui["copy-figma-prompt-button"].hidden = !artifact.currentContent;
  ui["confirm-figma-prompt-button"].hidden = artifact.lifecycleStatus !== "CURRENT" || artifact.reviewStatus !== "DRAFT";
  const versions = artifact.sourceVersions;
  ui["figma-prompt-source"].textContent = versions ? `Product State v${versions.confirmedProductStateVersion} · PRD v${versions.prd} · Interaction v${versions.interaction}` : "";
  ui["figma-prompt-blocking"].hidden = (artifact.blockingIssues || []).length === 0;
  ui["figma-prompt-blocking"].textContent = (artifact.blockingIssues || []).join("\n");
}

function statusClass() {
  if (!state.project) return "status-empty";
  if (stageStatus() === "READY_FOR_CONFIRMATION") return "status-ready";
  if (stageStatus() === "CONFIRMED") return "status-confirmed";
  return "";
}

function renderMessages() {
  ui.messages.replaceChildren();
  const messages = (state.project.messages || []).filter(message => (message.stage || "DISCOVERY") === activeStage());
  if (messages.length === 0 && !state.pendingMessage) {
    ui.messages.append(emptyNode(activeStage() === "SOLUTION" ? "初始 Product Solution 将在这里出现。" : "AI 的第一轮问题将在这里出现。"));
  }
  for (const message of messages) ui.messages.append(messageNode(message.role, message.content));
  if (state.pendingMessage) {
    const pending = messageNode("user", state.pendingMessage);
    pending.classList.add("message-pending");
    ui.messages.append(pending);
  }
  requestAnimationFrame(() => {
    const scroll = ui["conversation-scroll"];
    scroll.scrollTop = scroll.scrollHeight;
  });
}

function messageNode(role, content) {
  const item = node("article", `message message-${role}`);
  item.append(node("p", "message-role", role === "assistant" ? `${stageName()} AI` : "You"));
  item.append(node("p", "message-body", content));
  return item;
}

function renderReadiness() {
  ui["readiness-status"].textContent = displayStatus();
  ui["readiness-reasons"].replaceChildren();
  if (!state.project) {
    ui["readiness-reasons"].textContent = "Create a project to begin Discovery.";
    return;
  }
  const stage = state.project.workflow.stages[activeStage()];
  if (stage.status === "CONFIRMED") {
    ui["readiness-reasons"].textContent = `Confirmed at content version ${stage.confirmedVersion ?? stage.contentVersion}.`;
    return;
  }
  if (stage.status === "READY_FOR_CONFIRMATION") {
    ui["readiness-reasons"].textContent = stage.readyEvaluation?.summary || `The server marked ${stageName()} ready for user confirmation.`;
    return;
  }
  const reasons = [];
  for (const issue of stage.blockingIssues || []) reasons.push(issue);
  const openBlocking = state.project.productSpec.openQuestions.filter(question => question.ownerStage === activeStage() && question.status === "OPEN" && question.blocking);
  for (const question of openBlocking) reasons.push(question.question);
  for (const criterion of stage.readyEvaluation?.criteria || []) {
    if (criterion.status === "MISSING" || criterion.status === "PARTIAL") reasons.push(`${criterion.criterionId}: ${criterion.reason}`);
  }
  if (reasons.length === 0) {
    ui["readiness-reasons"].textContent = `The server has not marked ${stageName()} ready. Continue with the current AI question.`;
    return;
  }
  ui["readiness-reasons"].append(node("span", "", "Still blocking Ready:"));
  const list = node("ul");
  for (const reason of [...new Set(reasons)]) list.append(node("li", "", reason));
  ui["readiness-reasons"].append(list);
}

function renderSpec() {
  ui["spec-content"].replaceChildren();
  if (!state.project) {
    ui["spec-content"].append(emptyNode("Product Spec fields will appear after the first completed AI turn."));
    return;
  }
  if (activeStage() === "SOLUTION") {
    renderSolutionSpec();
    return;
  }
  const discovery = state.project.productSpec.discovery;
  const background = [
    discovery.background?.requirementSource,
    discovery.background?.whyNow,
    discovery.background?.context
  ].filter(Boolean);
  addSpecSection("Background", background);
  addSpecSection("Primary Goal", discovery.goals.primary ? [discovery.goals.primary] : []);
  addSpecSection("Secondary Goals", discovery.goals.secondary);
  addSpecSection("Target User", discovery.users.primary.map(actor => actor.description ? `${actor.name} — ${actor.description}` : actor.name));

  const problem = [];
  if (discovery.problem?.statement) problem.push(discovery.problem.statement);
  if (discovery.behaviorChange?.basis?.type === "EVIDENCED_FRICTION") problem.push(`Core friction: ${discovery.behaviorChange.basis.friction}`);
  if (discovery.behaviorChange?.basis?.type === "ACCEPTED_ASSUMPTION") problem.push(`Accepted friction assumption: ${discovery.behaviorChange.basis.assumption}`);
  addSpecSection("User Problem / Friction", problem);

  addSpecSection("Core Scenario", discovery.scenarios.map(scenario => `${scenario.context} → ${scenario.goal}${scenario.currentProblem ? ` (${scenario.currentProblem})` : ""}`));
  addSpecSection("Existing Capabilities", discovery.currentProduct.capabilities);
  addSpecSection("Constraints", discovery.constraints.map(item => `[${item.type}] ${item.description}`));

  const assumptions = discovery.hypotheses.map(item => item.rationale ? `${item.statement} — ${item.rationale}` : item.statement);
  if (discovery.behaviorChange?.basis?.type === "ACCEPTED_ASSUMPTION") {
    assumptions.unshift(discovery.behaviorChange.basis.assumption);
  }
  const assumptionMeta = discovery.behaviorChange?.basis?.type === "ACCEPTED_ASSUMPTION"
    ? `Evidence status: ${discovery.behaviorChange.basis.evidenceStatus}`
    : "";
  addSpecSection("Assumptions", assumptions, assumptionMeta);

  const validation = [];
  if (discovery.behaviorChange?.basis?.type === "ACCEPTED_ASSUMPTION") validation.push(discovery.behaviorChange.basis.validationIntent);
  for (const question of state.project.productSpec.openQuestions) {
    if (question.ownerStage === "DISCOVERY" && question.status === "OPEN" && question.validation) {
      validation.push(question.validation.expectedOutput ? `${question.question} — Expected: ${question.validation.expectedOutput}` : question.question);
    }
  }
  addSpecSection("Validation Intent", validation);
}

function renderSolutionSpec() {
  const solution = state.project.productSpec.solution;
  addSpecSection("Solution Summary", solution.summary ? [solution.summary] : []);
  addSpecSection("Core Solution", solution.coreSolution ? [solution.coreSolution] : []);
  addSpecSection("Key Mechanisms", solution.keyMechanisms.map(item => `${item.name} — ${item.description}`));
  addSpecSection("In Scope", solution.scope.inScope);
  addSpecSection("Out of Scope", solution.scope.outOfScope);
  addSpecSection("Key Rules", solution.keyRules.map(item => item.rationale ? `${item.rule} — ${item.rationale}` : item.rule));
  addSpecSection("Main Product Flow", solution.mainProductFlow.map((item, index) => `${index + 1}. ${item.actor ? `${item.actor}: ` : ""}${item.step}${item.outcome ? ` → ${item.outcome}` : ""}`));
  addSpecSection("Trade-offs", solution.tradeOffs.map(item => `${item.topic}: ${item.decision} — ${item.rationale}`));
  addSpecSection("Risks", solution.risks.map(item => item.mitigation ? `${item.risk} — Mitigation: ${item.mitigation}` : item.risk));
  addSpecSection("Assumptions", solution.assumptions.map(item => item.validationIntent ? `${item.assumption} — Validate: ${item.validationIntent}` : item.assumption));
}

function discoveryHandoffSummary() {
  const discovery = state.project.productSpec.discovery;
  return [
    discovery.problem?.statement ? `Problem: ${discovery.problem.statement}` : "",
    discovery.goals.primary ? `Goal: ${discovery.goals.primary}` : "",
    discovery.users.primary.length ? `Users: ${discovery.users.primary.map(item => item.name).join(", ")}` : "",
    discovery.direction?.summary ? `Direction: ${discovery.direction.summary}` : "",
    discovery.constraints.length ? `Constraints: ${discovery.constraints.map(item => item.description).join("; ")}` : ""
  ].filter(Boolean).join("\n");
}

function addSpecSection(title, values, meta = "") {
  const section = node("section", "spec-section");
  section.append(node("h3", "", title));
  const normalized = values.filter(value => typeof value === "string" && value.trim());
  if (normalized.length === 0) {
    section.append(emptyNode("Not established yet"));
  } else if (normalized.length === 1) {
    section.append(node("p", "", normalized[0]));
  } else {
    const list = node("ul");
    normalized.forEach(value => list.append(node("li", "", value)));
    section.append(list);
  }
  if (meta) section.append(node("p", "meta-line", meta));
  ui["spec-content"].append(section);
}

function renderQuestions() {
  const questions = state.project?.productSpec?.openQuestions?.filter(question => question.ownerStage === activeStage() && question.status === "OPEN") || [];
  const blocking = questions.filter(question => question.blocking);
  const nonblocking = questions.filter(question => !question.blocking);
  renderQuestionGroup(ui["blocking-questions"], blocking, true);
  renderQuestionGroup(ui["nonblocking-questions"], nonblocking, false);
  ui["blocking-count"].textContent = String(blocking.length);
  ui["nonblocking-count"].textContent = String(nonblocking.length);
}

function renderQuestionGroup(container, questions, blocking) {
  container.replaceChildren();
  if (questions.length === 0) {
    container.append(emptyNode(blocking ? "No server-reported blocking questions." : "No non-blocking questions."));
    return;
  }
  for (const question of questions) {
    const card = node("article", `question-card${blocking ? " blocking" : ""}`);
    card.append(node("p", "", question.question));
    card.append(node("p", "card-impact", question.impact));
    card.append(node("p", "card-meta", `${blocking ? "Blocking" : "Non-blocking"} · ${question.resolutionMethod}`));
    container.append(card);
  }
}

function renderDecisions() {
  const query = ui["decision-search"].value.trim().toLocaleLowerCase();
  const decisions = (state.project?.productSpec?.decisions || []).filter(decision => !query || decisionSearchText(decision).includes(query));
  const active = decisions.filter(decision => decision.status === "ACTIVE");
  const deferred = decisions.filter(decision => decision.status === "DEFERRED");
  const superseded = decisions.filter(decision => decision.status === "SUPERSEDED");
  renderDecisionGroup(ui["active-decisions"], active, false);
  renderDecisionGroup(ui["deferred-decisions"], deferred, false);
  renderDecisionGroup(ui["superseded-decisions"], superseded, true);
  ui["deferred-count"].textContent = String(deferred.length);
  ui["deferred-decisions-wrap"].hidden = deferred.length === 0;
  ui["superseded-count"].textContent = String(superseded.length);
  ui["superseded-decisions-wrap"].hidden = superseded.length === 0;
  const memory = state.project?.decisionMemory;
  ui["decision-scan-status"].textContent = memory?.status === "FAILED"
    ? `Last scan failed · ${memory.lastError || "unknown error"}`
    : memory?.status === "PENDING"
      ? `${memory.pendingMessageCount || 0} messages pending`
    : memory?.lastScannedAt
      ? `Scanned ${formatDate(memory.lastScannedAt)}`
      : "Not scanned yet";
}

function renderDecisionGroup(container, decisions, superseded) {
  container.replaceChildren();
  if (decisions.length === 0) {
    if (!superseded) container.append(emptyNode(`No ${stageName()} decisions recorded.`));
    return;
  }
  for (const decision of decisions.sort((left, right) => (right.updatedAt || "").localeCompare(left.updatedAt || ""))) {
    const card = node("details", `decision-card${superseded ? " superseded" : ""}`);
    const summary = node("summary", "decision-summary");
    const title = node("span", "decision-summary-copy");
    title.append(node("strong", "", decision.topic || decision.decision));
    title.append(node("span", "", decision.decision));
    summary.append(title, node("span", "decision-importance", `P${decision.importance || 2}`));
    card.append(summary);
    const detail = node("div", "decision-detail");
    detail.append(decisionField("Feature", decision.feature || decision.stage));
    detail.append(decisionField("Decision", decision.decision));
    detail.append(decisionField("Why / Reason", decision.reason || decision.rationale?.join(" · ") || "No reason captured"));
    detail.append(decisionField("Strength", decision.strength || "EXPLICIT"));
    detail.append(decisionField("Importance", String(decision.importance || 2)));
    detail.append(decisionField("Status", decision.status));
    detail.append(decisionList("Alternatives", (decision.alternatives || []).map(item => item.rejectionReason ? `${item.option} — ${item.rejectionReason}` : item.option)));
    detail.append(decisionList("History", decisionHistory(decision)));
    detail.append(decisionList("Source Discussion", decisionSources(decision)));
    detail.append(node("p", "card-meta", `Updated ${formatDate(decision.updatedAt || decision.createdAt)} · ${decision.stage}`));
    card.append(detail);
    container.append(card);
  }
}

function decisionField(label, value) {
  const field = node("div", "decision-field");
  field.append(node("span", "", label), node("p", "", value));
  return field;
}

function decisionList(label, values) {
  const field = node("div", "decision-field");
  field.append(node("span", "", label));
  if (!values.length) field.append(node("p", "empty-value", "None recorded"));
  else {
    const list = node("ul");
    values.forEach(value => list.append(node("li", "", value)));
    field.append(list);
  }
  return field;
}

function decisionHistory(decision) {
  const related = state.project.productSpec.decisions.filter(item => item.id === decision.supersedesDecisionId || item.id === decision.supersededBy);
  return [
    ...(decision.history || []).map(item => `${item.action} · ${formatDate(item.at)} · ${item.decision}${item.reason ? ` — ${item.reason}` : ""}`),
    ...related.map(item => `${item.status} · ${item.topic || item.decision}: ${item.decision}`)
  ];
}

function decisionSources(decision) {
  const ids = decision.sourceMessageIds?.length ? decision.sourceMessageIds : decision.source?.messageId ? [decision.source.messageId] : [];
  return ids.map(id => state.project.messages.find(message => message.id === id)).filter(Boolean)
    .map(message => `${message.role === "assistant" ? "AI" : "You"}: ${message.content}`);
}

function decisionSearchText(decision) {
  return [
    decision.feature, decision.topic, decision.decision, decision.reason, ...(decision.rationale || []),
    ...(decision.alternatives || []).flatMap(item => [item.option, item.rejectionReason])
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function emptyNode(text) {
  return node("p", "empty-value", text);
}

function showError(error, failedMessage = "") {
  state.lastFailedMessage = failedMessage;
  state.retryAllowed = Boolean(failedMessage && error instanceof ApiError && error.status !== 409);
  ui["error-message"].textContent = error instanceof Error ? error.message : "Unknown error";
  ui["error-panel"].hidden = false;
  ui["retry-button"].hidden = !state.retryAllowed;
}

function clearError() {
  ui["error-panel"].hidden = true;
  state.lastFailedMessage = "";
  state.retryAllowed = false;
}

async function loadProviderLibrary() {
  state.providerLibrary = await api("/api/providers");
  renderProviderLibrary();
}

function renderProviderLibrary() {
  const library = state.providerLibrary;
  if (!library) {
    ui["provider-summary"].textContent = "AI: Unavailable";
    return;
  }
  const activeModel = library.active.activeModel || "CLI default";
  ui["provider-summary"].textContent = `AI: ${library.active.name} · ${activeModel}`;
  ui["provider-summary"].title = `${library.active.name} · ${activeModel}`;
  ui["provider-current-name"].textContent = library.active.name;
  ui["provider-current-model"].textContent = activeModel;
  renderDecisionProviderSettings();
  ui["provider-profile-list"].replaceChildren();

  for (const profile of library.profiles) {
    const isActive = profile.id === library.activeProfileId;
    const card = node("article", `provider-profile-card${isActive ? " active" : ""}`);
    const copy = node("div", "provider-profile-copy");
    copy.append(node("strong", "", profile.name));
    const detail = profile.kind === "codex"
      ? "Local Codex CLI · no API key"
      : `${profile.baseURL} · ${profile.apiKeyMasked || "key missing"}`;
    copy.append(node("span", "", detail));

    const modelSelect = document.createElement("select");
    modelSelect.className = "provider-profile-model";
    modelSelect.setAttribute("aria-label", `Model for ${profile.name}`);
    const models = profile.models.length ? profile.models : [""];
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model || "CLI default";
      option.selected = model === profile.activeModel;
      modelSelect.append(option);
    }

    const actions = node("div", "provider-profile-actions");
    if (isActive) actions.append(node("span", "provider-active-mark", "ACTIVE"));
    const activate = node("button", isActive ? "secondary-button" : "primary-button", isActive ? "Apply model" : "Use");
    activate.type = "button";
    activate.disabled = state.providerBusy || (isActive && modelSelect.value === profile.activeModel);
    modelSelect.addEventListener("change", () => {
      activate.disabled = state.providerBusy || (isActive && modelSelect.value === profile.activeModel);
    });
    activate.addEventListener("click", () => void activateProviderProfile(profile.id, modelSelect.value));
    actions.append(activate);

    if (!profile.builtIn) {
      const edit = node("button", "secondary-button", "Edit");
      edit.type = "button";
      edit.disabled = state.providerBusy;
      edit.addEventListener("click", () => editProviderProfile(profile));
      const remove = node("button", "text-button danger-button", "Delete");
      remove.type = "button";
      const isDecisionProvider = profile.id === library.decisionExtraction?.profileId;
      remove.disabled = state.providerBusy || isActive || isDecisionProvider;
      remove.title = isActive
        ? "Switch to another provider before deleting this profile"
        : isDecisionProvider
          ? "Select another Decision Extraction provider before deleting this profile"
          : "Delete API profile";
      remove.addEventListener("click", () => void deleteProviderProfile(profile));
      actions.append(edit, remove);
    }
    card.append(copy, modelSelect, actions);
    ui["provider-profile-list"].append(card);
  }
}

function renderDecisionProviderSettings() {
  const library = state.providerLibrary;
  const profiles = library?.profiles?.filter(profile => profile.kind === "openai-compatible") || [];
  const profileSelect = ui["decision-provider-profile"];
  profileSelect.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    option.selected = profile.id === library.decisionExtraction?.profileId;
    profileSelect.append(option);
  }
  renderDecisionProviderModels(library?.decisionExtraction?.model);
  const unavailable = profiles.length === 0;
  profileSelect.disabled = state.providerBusy || unavailable;
  ui["decision-provider-model"].disabled = state.providerBusy || unavailable;
  ui["save-decision-provider"].disabled = state.providerBusy || unavailable;
}

function renderDecisionProviderModels(selectedModel) {
  const profile = state.providerLibrary?.profiles?.find(item => item.id === ui["decision-provider-profile"].value);
  const modelSelect = ui["decision-provider-model"];
  modelSelect.replaceChildren();
  for (const model of profile?.models || []) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === selectedModel;
    modelSelect.append(option);
  }
}

function showProviderError(error) {
  ui["provider-library-error"].textContent = error instanceof Error ? error.message : "Provider configuration failed";
  ui["provider-library-error"].hidden = false;
}

function clearProviderError() {
  ui["provider-library-error"].hidden = true;
  ui["provider-library-error"].textContent = "";
}

function resetProviderForm() {
  ui["provider-form"].reset();
  ui["provider-edit-id"].value = "";
  ui["provider-form-title"].textContent = "Add API profile";
  ui["provider-form-cancel"].hidden = true;
  ui["provider-save-button"].textContent = "Save API profile";
  ui["provider-api-key-input"].required = true;
  ui["provider-api-key-input"].placeholder = "Required when adding; leave blank to keep existing key";
}

function editProviderProfile(profile) {
  clearProviderError();
  ui["provider-edit-id"].value = profile.id;
  ui["provider-name-input"].value = profile.name;
  ui["provider-base-url-input"].value = profile.baseURL || "";
  ui["provider-api-key-input"].value = "";
  ui["provider-api-key-input"].required = false;
  ui["provider-api-key-input"].placeholder = `${profile.apiKeyMasked || "Saved key"} · leave blank to keep`;
  ui["provider-models-input"].value = profile.models.join("\n");
  ui["provider-default-model-input"].value = profile.activeModel;
  ui["provider-form-title"].textContent = `Edit ${profile.name}`;
  ui["provider-form-cancel"].hidden = false;
  ui["provider-save-button"].textContent = "Save changes";
  ui["provider-name-input"].focus();
}

async function activateProviderProfile(id, model) {
  if (state.providerBusy) return;
  state.providerBusy = true;
  clearProviderError();
  renderProviderLibrary();
  try {
    state.providerLibrary = await api(`/api/providers/${encodeURIComponent(id)}/activate`, {
      method: "POST",
      body: JSON.stringify({ model: model || undefined })
    });
  } catch (error) {
    showProviderError(error);
  } finally {
    state.providerBusy = false;
    renderProviderLibrary();
  }
}

async function deleteProviderProfile(profile) {
  if (state.providerBusy || !window.confirm(`Delete API profile “${profile.name}”?`)) return;
  state.providerBusy = true;
  clearProviderError();
  try {
    await api(`/api/providers/${encodeURIComponent(profile.id)}`, { method: "DELETE" });
    await loadProviderLibrary();
    if (ui["provider-edit-id"].value === profile.id) resetProviderForm();
  } catch (error) {
    showProviderError(error);
  } finally {
    state.providerBusy = false;
    renderProviderLibrary();
  }
}

function providerModelsFromInput() {
  return [...new Set(ui["provider-models-input"].value.split(/[\n,]/).map(model => model.trim()).filter(Boolean))];
}

async function performStageMessage(content, action) {
  const result = await api(`/projects/${state.project.id}/messages`, {
    method: "POST",
    headers: { "x-request-id": action.requestId },
    body: JSON.stringify({ content })
  });
  state.project = result.project;
}

async function prepareManualBridgeTurn(content, kind = "USER_MESSAGE") {
  const result = await api(`/projects/${state.project.id}/manual-bridge/prompt`, {
    method: "POST",
    body: JSON.stringify(kind === "SOLUTION_START" ? { kind } : { kind, content })
  });
  state.manualBridgeTurn = result;
  state.manualBridgeResponse = "";
  ui["manual-bridge-copy-status"].textContent = "";
  return result;
}

function clearManualBridgeTurn() {
  state.manualBridgeTurn = null;
  state.manualBridgeResponse = "";
  state.pendingMessage = "";
  ui["manual-bridge-response"].value = "";
  ui["manual-bridge-copy-status"].textContent = "";
}

async function sendManualBridgeMessage(content) {
  if (!state.project || state.manualBridgeTurn) return;
  clearError();
  state.notice = "";
  state.pendingMessage = content;
  setBusy(true, "Preparing the ChatGPT Manual Bridge prompt");
  render();
  try {
    await prepareManualBridgeTurn(content);
    state.notice = `ChatGPT prompt prepared from Revision ${state.manualBridgeTurn.expectedRevision}. No project state has changed yet.`;
    ui["message-input"].value = "";
  } catch (error) {
    state.pendingMessage = "";
    showError(error, content);
  } finally {
    setBusy(false);
    render();
  }
}

async function sendStageMessage(content, actionKind = "user-message") {
  if (!state.project || stageStatus() === "CONFIRMED") return;
  if (isManualBridgeMode()) return sendManualBridgeMessage(content);
  if (state.busy && !submissionGuard.isActive()) return;
  const action = submissionGuard.begin(actionKind, { project_id: state.project.id });
  if (!action) return;
  clearError();
  state.notice = "";
  beginRequestProgress(action.requestId);
  const priorRevision = state.project.productSpec.version.revision;
  state.pendingMessage = content;
  render();
  setBusy(true, `${stageName()} is reviewing your answer`);
  try {
    await performStageMessage(content, action);
    const nextRevision = state.project.productSpec.version.revision;
    if (nextRevision !== priorRevision) state.notice = `Structured requirement updated · Revision ${priorRevision} → ${nextRevision}`;
    state.pendingMessage = "";
    ui["message-input"].value = "";
  } catch (error) {
    state.pendingMessage = "";
    showError(error, content);
  } finally {
    endRequestProgress();
    submissionGuard.finish(action);
    setBusy(false);
    render();
  }
}

function leaveProject() {
  clearManualBridgeTurn();
  state.dirtyArtifacts.clear();
  state.project = null;
  state.notice = "";
  window.localStorage.removeItem("discoveryProjectId");
  window.history.replaceState(null, "", "/");
  clearError();
  render();
}

function hasUnsavedWork() {
  if (!state.project) return false;
  return Boolean(state.manualBridgeTurn || state.dirtyArtifacts.size > 0);
}

function confirmDiscardUnsavedWork() {
  return !hasUnsavedWork() || window.confirm("Discard unsaved artifact or Manual Bridge changes and leave this project?");
}

async function copyText(content, notice) {
  if (!content) return;
  try {
    await navigator.clipboard.writeText(content);
    state.notice = notice;
    ui["revision-notice"].hidden = false;
    ui["revision-notice"].textContent = notice;
  } catch (error) {
    showError(error);
  }
}

const projectDeletion = createProjectDeletionController({
  confirmDelete: message => window.confirm(message),
  deleteById: projectId => api(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }),
  getActiveProjectId: () => state.project?.id ?? null,
  clearActiveProject: leaveProject,
  removeProjectFromHistory(projectId) {
    state.projects = state.projects.filter(project => project.id !== projectId);
    renderProjectHistory();
    renderProjectStorage();
  },
  refreshProjects: loadProjectHistory,
  onConfirmed() {
    clearError();
    setBusy(true, "Deleting project");
  },
  onSettled() {
    setBusy(false);
  }
});

ui["provider-settings-button"].addEventListener("click", async () => {
  clearProviderError();
  ui["provider-dialog"].showModal();
  try {
    await loadProviderLibrary();
  } catch (error) {
    showProviderError(error);
  }
});

ui["provider-dialog-close"].addEventListener("click", () => ui["provider-dialog"].close());
ui["provider-form-cancel"].addEventListener("click", resetProviderForm);
ui["decision-provider-profile"].addEventListener("change", () => renderDecisionProviderModels());
ui["save-decision-provider"].addEventListener("click", async () => {
  if (state.providerBusy) return;
  state.providerBusy = true;
  clearProviderError();
  renderProviderLibrary();
  try {
    state.providerLibrary = await api("/api/providers/decision-extraction", {
      method: "POST",
      body: JSON.stringify({
        profileId: ui["decision-provider-profile"].value,
        model: ui["decision-provider-model"].value
      })
    });
  } catch (error) {
    showProviderError(error);
  } finally {
    state.providerBusy = false;
    renderProviderLibrary();
  }
});

ui["provider-form"].addEventListener("submit", async event => {
  event.preventDefault();
  if (state.providerBusy) return;
  clearProviderError();
  const id = ui["provider-edit-id"].value;
  const apiKey = ui["provider-api-key-input"].value.trim();
  const payload = {
    name: ui["provider-name-input"].value.trim(),
    baseURL: ui["provider-base-url-input"].value.trim(),
    models: providerModelsFromInput(),
    activeModel: ui["provider-default-model-input"].value.trim() || undefined,
    ...(!id || apiKey ? { apiKey } : {})
  };
  state.providerBusy = true;
  ui["provider-save-button"].disabled = true;
  try {
    state.providerLibrary = await api(id ? `/api/providers/${encodeURIComponent(id)}` : "/api/providers", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(payload)
    });
    resetProviderForm();
  } catch (error) {
    showProviderError(error);
  } finally {
    state.providerBusy = false;
    ui["provider-save-button"].disabled = false;
    renderProviderLibrary();
  }
});

ui["projects-button"].addEventListener("click", async () => {
  if (state.busy) return;
  try {
    await loadProjectHistory();
    if (!confirmDiscardUnsavedWork()) return;
    leaveProject();
    ui["project-history-title"]?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showError(error);
  }
});

ui["new-project-button"].addEventListener("click", () => {
  if (state.busy) return;
  if (!confirmDiscardUnsavedWork()) return;
  leaveProject();
  ui["initial-requirement"].value = "";
  ui["project-name-input"].focus();
});

ui["reload-projects-button"].addEventListener("click", async () => {
  if (state.busy) return;
  try {
    await loadProjectHistory();
  } catch (error) {
    showError(error);
  }
});

ui["rename-project-button"].addEventListener("click", async () => {
  const name = ui["manage-project-name"].value.trim();
  if (!state.project || state.busy || !name || name === state.project.productSpec.project.name) return;
  setBusy(true, "Renaming project");
  try {
    state.project = await api(`/projects/${state.project.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
    await loadProjectHistory();
    state.notice = "Project renamed and saved.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

ui["export-project-button"].addEventListener("click", () => {
  if (!state.project || state.busy) return;
  const link = document.createElement("a");
  link.href = `/projects/${encodeURIComponent(state.project.id)}/export`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
});

ui["clear-prd-button"].addEventListener("click", async () => {
  if (!state.project || state.busy) return;
  if (!window.confirm("Clear the PRD and its downstream Interaction and Figma artifacts? This cannot be undone unless you exported the project first.")) return;
  await clearArtifact("prd", "PRD and downstream Interaction and Figma artifacts cleared.");
});

ui["clear-interaction-button"].addEventListener("click", async () => {
  if (!state.project || state.busy) return;
  if (!window.confirm("Clear the Interaction Specification and downstream Figma prompt?")) return;
  await clearArtifact("interaction", "Interaction Specification and downstream Figma prompt cleared.");
});

ui["clear-figma-button"].addEventListener("click", async () => {
  if (!state.project || state.busy) return;
  if (!window.confirm("Clear the generated Codex Figma prompt?")) return;
  await clearArtifact("figma-prompt", "Codex Figma prompt cleared.");
});

async function clearArtifact(path, notice) {
  setBusy(true, "Clearing generated artifact");
  try {
    const result = await api(`/projects/${state.project.id}/artifacts/${path}`, { method: "DELETE" });
    state.project = result.project;
    state.dirtyArtifacts.delete(path === "figma-prompt" ? "figma" : path);
    await loadProjectHistory();
    state.notice = notice;
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
}

ui["cleanup-artifacts-button"].addEventListener("click", async () => {
  if (!state.project || state.busy) return;
  setBusy(true, "Cleaning stale and failed artifacts");
  try {
    const result = await api(`/projects/${state.project.id}/artifacts/cleanup`, { method: "POST", body: "{}" });
    state.project = result.project;
    await loadProjectHistory();
    state.notice = result.removed.length ? `Cleaned: ${result.removed.join(", ")}.` : "No stale or failed artifacts to clean.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

ui["delete-project-button"].addEventListener("click", async () => {
  if (!state.project || state.busy) return;
  const project = { id: state.project.id, name: state.project.productSpec.project.name };
  try {
    await projectDeletion.deleteProject(project);
  } catch (error) {
    showError(error);
  } finally {
    render();
  }
});

ui["create-form"].addEventListener("submit", async event => {
  event.preventDefault();
  if (state.busy && !submissionGuard.isActive()) return;
  const initialRequirement = ui["initial-requirement"].value.trim();
  const projectName = ui["project-name-input"].value.trim() || initialRequirement.split(/\r?\n/)[0].slice(0, 80) || "Untitled Project";
  if (!initialRequirement) return;
  const action = submissionGuard.begin("initial-discovery", { project_name: projectName });
  if (!action) return;
  clearError();
  clearManualBridgeTurn();
  setBusy(true, "Creating your Discovery workspace");
  let projectCreated = false;
  try {
    state.project = await api("/projects", {
      method: "POST",
      headers: { "x-request-id": action.requestId },
      body: JSON.stringify({ name: projectName, initialRequirement })
    });
    projectCreated = true;
    void loadProjectHistory().catch(error => console.warn("Project history refresh failed", error));
    window.localStorage.setItem("discoveryProjectId", state.project.id);
    window.history.replaceState(null, "", `/?project=${encodeURIComponent(state.project.id)}`);
    const priorRevision = state.project.productSpec.version.revision;
    state.pendingMessage = initialRequirement;
    render();
    if (isManualBridgeMode()) {
      ui["activity-title"].textContent = "Preparing the first ChatGPT Manual Bridge prompt";
      await prepareManualBridgeTurn(initialRequirement);
      state.notice = `ChatGPT prompt prepared from Revision ${priorRevision}. No project state has changed yet.`;
    } else {
      beginRequestProgress(action.requestId);
      ui["activity-title"].textContent = "Discovery is reviewing your initial requirement";
      await performStageMessage(initialRequirement, action);
      const nextRevision = state.project.productSpec.version.revision;
      if (nextRevision !== priorRevision) state.notice = `Structured requirement updated · Revision ${priorRevision} → ${nextRevision}`;
      state.pendingMessage = "";
    }
    ui["message-input"].value = "";
  } catch (error) {
    state.pendingMessage = "";
    showError(error, projectCreated ? initialRequirement : "");
  } finally {
    endRequestProgress();
    submissionGuard.finish(action);
    setBusy(false);
    render();
  }
});

ui["interaction-mode"].addEventListener("change", () => {
  if (state.manualBridgeTurn) {
    ui["interaction-mode"].value = state.interactionMode;
    return;
  }
  state.interactionMode = ui["interaction-mode"].value === "manual" ? "manual" : "provider";
  window.localStorage.setItem("workflowInteractionMode", state.interactionMode);
  state.notice = isManualBridgeMode()
    ? "ChatGPT Manual Bridge enabled. Sending creates a copyable prompt and does not call the configured Provider."
    : "API / Local Codex mode enabled.";
  render();
});

ui["copy-manual-bridge-prompt"].addEventListener("click", async () => {
  const prompt = state.manualBridgeTurn?.prompt;
  if (!prompt) return;
  try {
    await navigator.clipboard.writeText(prompt);
    ui["manual-bridge-copy-status"].textContent = "Copied. Paste it into ChatGPT.";
  } catch (error) {
    showError(error);
  }
});

ui["manual-bridge-response"].addEventListener("input", () => {
  state.manualBridgeResponse = ui["manual-bridge-response"].value;
  ui["manual-bridge-step"].textContent = state.manualBridgeResponse.trim() ? "2 · Apply response" : "1 · Copy prompt";
  ui["apply-manual-bridge"].disabled = state.busy || !state.manualBridgeResponse.trim();
});

ui["cancel-manual-bridge"].addEventListener("click", () => {
  clearManualBridgeTurn();
  state.notice = "Manual Bridge turn cancelled. Project state was not changed.";
  render();
});

ui["apply-manual-bridge"].addEventListener("click", async () => {
  const turn = state.manualBridgeTurn;
  const response = state.manualBridgeResponse.trim();
  if (!state.project || !turn || !response || state.busy) return;
  clearError();
  const priorRevision = state.project.productSpec.version.revision;
  setBusy(true, "Validating and applying the ChatGPT response locally");
  try {
    const result = await api(`/projects/${state.project.id}/manual-bridge/apply`, {
      method: "POST",
      body: JSON.stringify({
        stage: turn.stage,
        kind: turn.kind,
        expectedRevision: turn.expectedRevision,
        expectedRecordVersion: turn.expectedRecordVersion,
        turnToken: turn.turnToken,
        userMessage: turn.userMessage,
        response
      })
    });
    state.project = result.project;
    clearManualBridgeTurn();
    ui["message-input"].value = "";
    const nextRevision = state.project.productSpec.version.revision;
    state.notice = nextRevision === priorRevision
      ? "ChatGPT response validated and saved. No structured facts changed."
      : `ChatGPT response validated and applied · Revision ${priorRevision} → ${nextRevision}`;
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

ui["message-form"].addEventListener("submit", event => {
  event.preventDefault();
  const content = ui["message-input"].value.trim();
  if (content) void sendStageMessage(content);
});

ui["message-input"].addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    ui["message-form"].requestSubmit();
  }
});

ui["prd-content"].addEventListener("input", () => state.dirtyArtifacts.add("prd"));
ui["interaction-content"].addEventListener("input", () => state.dirtyArtifacts.add("interaction"));
ui["figma-prompt-content"].addEventListener("input", () => state.dirtyArtifacts.add("figma"));

ui["decision-search"].addEventListener("input", renderDecisions);

ui["scan-decisions-button"].addEventListener("click", async event => {
  event.stopPropagation();
  if (!state.project || state.busy) return;
  clearError();
  setBusy(true, "整理当前项目的产品决策");
  try {
    const result = await api(`/projects/${state.project.id}/decisions/scan`, { method: "POST", body: "{}" });
    state.project = result.project;
    const scan = result.decisionScan;
    state.notice = scan.status === "FAILED"
      ? "对话已安全保留，但本次 Decision Extraction 失败；主流程未受影响。"
      : scan.status === "SKIPPED"
        ? scan.remainingMessageCount
          ? `已有 ${scan.remainingMessageCount} 条待扫描消息，尚未达到自动批量阈值。`
          : "没有尚未扫描的对话。"
        : `Decision Memory 已整理：新增 ${scan.created}，更新 ${scan.updated}，替代 ${scan.superseded}，忽略 ${scan.ignored}${scan.remainingMessageCount ? `；仍有 ${scan.remainingMessageCount} 条待扫描` : ""}。`;
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

ui["retry-button"].addEventListener("click", () => {
  if (state.retryAllowed && state.lastFailedMessage) void sendStageMessage(state.lastFailedMessage, "retry");
});

ui["refresh-button"].addEventListener("click", async () => {
  if (state.busy) return;
  setBusy(true, "Refreshing server state");
  try {
    if (state.project) state.project = await api(`/projects/${state.project.id}`);
    else await Promise.all([loadProjectHistory(), loadProviderLibrary()]);
    clearError();
    state.notice = state.project ? `Server state refreshed · Revision ${state.project.productSpec.version.revision}` : "Server state refreshed.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

ui["confirm-button"].addEventListener("click", async () => {
  if (!state.project || state.busy || state.manualBridgeTurn || stageStatus() !== "READY_FOR_CONFIRMATION") return;
  const stage = activeStage();
  const name = stageName();
  clearError();
  setBusy(true, `Confirming ${name}`);
  try {
    await api(`/projects/${state.project.id}/stages/${stage.toLowerCase()}/confirm`, { method: "POST", body: "{}" });
    state.project = await api(`/projects/${state.project.id}`);
    state.notice = `${name} confirmed at Revision ${state.project.productSpec.version.revision}`;
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

async function reopenStage(stage) {
  if (!state.project || state.busy) return;
  const label = stage === "DISCOVERY" ? "Discovery" : "Product Solution";
  const unsavedWarning = hasUnsavedWork() ? " Unsaved artifact edits will be discarded." : "";
  if (!window.confirm(`Reopen ${label}? Confirmed downstream state and generated artifacts will be marked for review or stale.${unsavedWarning}`)) return;
  clearError();
  setBusy(true, `Reopening ${label}`);
  try {
    const result = await api(`/projects/${state.project.id}/stages/${stage.toLowerCase()}/reopen`, { method: "POST", body: "{}" });
    state.project = result.project;
    state.dirtyArtifacts.clear();
    state.notice = `${label} reopened. Update it in the conversation, then confirm again.`;
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
}

ui["reopen-stage-button"].addEventListener("click", () => void reopenStage(activeStage()));
ui["reopen-discovery-button"].addEventListener("click", () => void reopenStage("DISCOVERY"));

ui["start-solution-button"].addEventListener("click", async () => {
  if (!state.project || state.busy || state.manualBridgeTurn || discoveryStatusForProject() !== "CONFIRMED" || state.project.workflow.stages.SOLUTION.status !== "NOT_STARTED") return;
  const action = submissionGuard.begin("start-solution", { project_id: state.project.id });
  if (!action) return;
  clearError();
  if (!isManualBridgeMode()) beginRequestProgress(action.requestId);
  setBusy(true, isManualBridgeMode() ? "Preparing the Product Solution ChatGPT prompt" : "Building the initial Product Solution from confirmed Discovery");
  try {
    if (isManualBridgeMode()) {
      await prepareManualBridgeTurn("", "SOLUTION_START");
      state.notice = `Product Solution kickoff prompt prepared from Revision ${state.manualBridgeTurn.expectedRevision}. The stage will start only after the pasted response validates.`;
    } else {
      const result = await api(`/projects/${state.project.id}/stages/solution/start`, {
        method: "POST",
        headers: { "x-request-id": action.requestId },
        body: "{}"
      });
      state.project = result.project;
      state.notice = `Product Solution started · Revision ${state.project.productSpec.version.revision}`;
    }
  } catch (error) {
    showError(error);
  } finally {
    endRequestProgress();
    submissionGuard.finish(action);
    setBusy(false);
    render();
  }
});

ui["generate-prd-button"].addEventListener("click", async () => {
  if (!state.project || state.busy || state.project.workflow.stages.SOLUTION.status !== "CONFIRMED") return;
  const action = submissionGuard.begin("generate-prd", { project_id: state.project.id });
  if (!action) return;
  clearError();
  beginRequestProgress(action.requestId);
  setBusy(true, "Selecting PRD capabilities and generating Requirement Details");
  try {
    const result = await api(`/projects/${state.project.id}/artifacts/prd/generate`, {
      method: "POST", headers: { "x-request-id": action.requestId }, body: "{}"
    });
    state.project = result.project;
    state.dirtyArtifacts.delete("prd");
    state.notice = result.artifact.reviewStatus === "BLOCKED"
      ? "PRD generation stopped because required context or Capability is missing."
      : "PRD Requirement Details generated as a reviewable draft.";
  } catch (error) {
    showError(error);
  } finally {
    endRequestProgress();
    submissionGuard.finish(action);
    setBusy(false);
    render();
  }
});

ui["submit-prd-clarification-button"].addEventListener("click", async () => {
  const answer = ui["prd-clarification-answer"].value.trim();
  if (!state.project || state.busy || !answer) return;
  const action = submissionGuard.begin("clarify-prd", { project_id: state.project.id });
  if (!action) return;
  clearError();
  beginRequestProgress(action.requestId);
  setBusy(true, "Continuing PRD generation from the saved clarification");
  try {
    const result = await api(`/projects/${state.project.id}/artifacts/prd/clarify`, {
      method: "POST",
      headers: { "x-request-id": action.requestId },
      body: JSON.stringify({ answer })
    });
    state.project = result.project;
    state.dirtyArtifacts.delete("prd");
    ui["prd-clarification-answer"].value = "";
    state.notice = result.artifact.reviewStatus === "BLOCKED"
      ? "The clarification was saved, but PRD generation still needs confirmed input."
      : "Clarification saved and PRD Requirement Details generated as a reviewable draft.";
  } catch (error) {
    showError(error);
  } finally {
    endRequestProgress();
    submissionGuard.finish(action);
    setBusy(false);
    render();
  }
});

ui["return-to-solution-button"].addEventListener("click", async () => {
  if (!state.project || state.busy || state.project.workflow.stages.SOLUTION.status !== "CONFIRMED") return;
  clearError();
  setBusy(true, "Reopening Product Solution");
  try {
    const result = await api(`/projects/${state.project.id}/stages/solution/reopen`, { method: "POST", body: "{}" });
    state.project = result.project;
    state.notice = "Product Solution reopened. Add or revise the missing product rule, then confirm it again.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

ui["save-prd-button"].addEventListener("click", async () => {
  const content = ui["prd-content"].value.trim();
  if (!state.project || state.busy || !content) return;
  clearError();
  setBusy(true, "Saving PRD changes");
  try {
    const result = await api(`/projects/${state.project.id}/artifacts/prd`, {
      method: "PATCH",
      body: JSON.stringify({ content })
    });
    state.project = result.project;
    state.dirtyArtifacts.delete("prd");
    state.notice = "PRD changes saved. Review and confirm when ready.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

ui["copy-prd-button"].addEventListener("click", () => {
  void copyText(ui["prd-content"].value, "PRD Markdown copied.");
});

ui["confirm-prd-button"].addEventListener("click", async () => {
  if (!state.project || state.busy) return;
  clearError();
  setBusy(true, "Confirming PRD Requirement Details");
  try {
    const content = ui["prd-content"].value.trim();
    if (content && content !== state.project.artifacts.prd.currentContent) {
      await api(`/projects/${state.project.id}/artifacts/prd`, {
        method: "PATCH",
        body: JSON.stringify({ content })
      });
    }
    const result = await api(`/projects/${state.project.id}/artifacts/prd/confirm`, { method: "POST", body: "{}" });
    state.project = result.project;
    state.dirtyArtifacts.delete("prd");
    state.notice = "PRD Requirement Details confirmed. Interaction Design can continue from this version.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

async function generateInteraction() {
  if (!state.project || state.busy) return;
  const action = submissionGuard.begin("generate-interaction", { project_id: state.project.id });
  if (!action) return;
  clearError();
  beginRequestProgress(action.requestId);
  setBusy(true, "Generating the Interaction Specification");
  try {
    const result = await api(`/projects/${state.project.id}/artifacts/interaction/generate`, {
      method: "POST", headers: { "x-request-id": action.requestId }, body: "{}"
    });
    state.project = result.project;
    state.dirtyArtifacts.delete("interaction");
    state.notice = result.artifact.reviewStatus === "BLOCKED"
      ? "Interaction generation stopped because confirmed input is missing."
      : "Interaction Specification generated as a reviewable draft.";
  } catch (error) {
    showError(error);
  } finally {
    endRequestProgress();
    submissionGuard.finish(action);
    setBusy(false);
    render();
  }
}

ui["continue-interaction-button"].addEventListener("click", generateInteraction);
ui["generate-interaction-button"].addEventListener("click", generateInteraction);

ui["submit-interaction-clarification-button"].addEventListener("click", async () => {
  const answer = ui["interaction-clarification-answer"].value.trim();
  if (!state.project || state.busy || !answer) return;
  const action = submissionGuard.begin("clarify-interaction", { project_id: state.project.id });
  if (!action) return;
  clearError();
  beginRequestProgress(action.requestId);
  setBusy(true, "Continuing Interaction generation from the saved clarification");
  try {
    const result = await api(`/projects/${state.project.id}/artifacts/interaction/clarify`, {
      method: "POST",
      headers: { "x-request-id": action.requestId },
      body: JSON.stringify({ answer })
    });
    state.project = result.project;
    state.dirtyArtifacts.delete("interaction");
    ui["interaction-clarification-answer"].value = "";
    state.notice = result.artifact.reviewStatus === "BLOCKED"
      ? "The clarification was saved, but Interaction still needs confirmed input."
      : "Clarification saved and Interaction Specification generated.";
  } catch (error) {
    showError(error);
  } finally {
    endRequestProgress();
    submissionGuard.finish(action);
    setBusy(false);
    render();
  }
});

ui["save-interaction-button"].addEventListener("click", async () => {
  const content = ui["interaction-content"].value.trim();
  if (!state.project || state.busy || !content) return;
  clearError();
  setBusy(true, "Saving Interaction changes");
  try {
    const result = await api(`/projects/${state.project.id}/artifacts/interaction`, {
      method: "PATCH",
      body: JSON.stringify({ content })
    });
    state.project = result.project;
    state.dirtyArtifacts.delete("interaction");
    state.notice = "Interaction changes saved.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

ui["copy-interaction-button"].addEventListener("click", () => {
  void copyText(ui["interaction-content"].value, "Interaction Specification Markdown copied.");
});

ui["confirm-interaction-button"].addEventListener("click", async () => {
  if (!state.project || state.busy) return;
  clearError();
  setBusy(true, "Confirming the Interaction Specification");
  try {
    const content = ui["interaction-content"].value.trim();
    if (content && content !== state.project.artifacts.interaction.currentContent) {
      await api(`/projects/${state.project.id}/artifacts/interaction`, {
        method: "PATCH",
        body: JSON.stringify({ content })
      });
    }
    const result = await api(`/projects/${state.project.id}/artifacts/interaction/confirm`, { method: "POST", body: "{}" });
    state.project = result.project;
    state.dirtyArtifacts.delete("interaction");
    state.notice = "Interaction Specification confirmed. Figma Prompt assembly can continue.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

ui["generate-figma-prompt-button"].addEventListener("click", async () => {
  if (!state.project || state.busy) return;
  const action = submissionGuard.begin("generate-figma-prompt", { project_id: state.project.id });
  if (!action) return;
  clearError();
  beginRequestProgress(action.requestId);
  setBusy(true, "Selecting Figma capabilities and assembling the Codex prompt");
  try {
    const result = await api(`/projects/${state.project.id}/artifacts/figma-prompt/generate`, {
      method: "POST", headers: { "x-request-id": action.requestId }, body: "{}"
    });
    state.project = result.project;
    state.dirtyArtifacts.delete("figma");
    state.notice = result.artifact.reviewStatus === "BLOCKED"
      ? "Figma Prompt assembly stopped because a required Capability is missing."
      : "Codex Figma prototype prompt assembled from the confirmed workflow context.";
  } catch (error) {
    showError(error);
  } finally {
    endRequestProgress();
    submissionGuard.finish(action);
    setBusy(false);
    render();
  }
});

ui["save-figma-prompt-button"].addEventListener("click", async () => {
  const content = ui["figma-prompt-content"].value.trim();
  if (!state.project || state.busy || !content) return;
  clearError();
  setBusy(true, "Saving the Codex Figma prompt");
  try {
    const result = await api(`/projects/${state.project.id}/artifacts/figma-prompt`, {
      method: "PATCH",
      body: JSON.stringify({ content })
    });
    state.project = result.project;
    state.dirtyArtifacts.delete("figma");
    state.notice = "Codex Figma prompt changes saved.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

ui["copy-figma-prompt-button"].addEventListener("click", async () => {
  await copyText(ui["figma-prompt-content"].value, "Codex Figma prototype prompt copied.");
});

ui["confirm-figma-prompt-button"].addEventListener("click", async () => {
  if (!state.project || state.busy) return;
  clearError();
  setBusy(true, "Confirming the Codex Figma prompt");
  try {
    const content = ui["figma-prompt-content"].value.trim();
    if (content && content !== state.project.artifacts.figmaPrompt.currentContent) {
      await api(`/projects/${state.project.id}/artifacts/figma-prompt`, {
        method: "PATCH",
        body: JSON.stringify({ content })
      });
    }
    const result = await api(`/projects/${state.project.id}/artifacts/figma-prompt/confirm`, { method: "POST", body: "{}" });
    state.project = result.project;
    state.dirtyArtifacts.delete("figma");
    state.notice = "Codex Figma prototype prompt confirmed and ready to copy.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    render();
  }
});

function discoveryStatusForProject() {
  return state.project?.workflow?.stages?.DISCOVERY?.status || "NOT_STARTED";
}

async function restoreProject() {
  const queryProjectId = new URLSearchParams(window.location.search).get("project");
  const projectId = queryProjectId || window.localStorage.getItem("discoveryProjectId");
  if (!projectId) return;
  try {
    const project = await api(`/projects/${encodeURIComponent(projectId)}`);
    if (projectDeletion.wasDeleted(projectId)) return;
    state.project = project;
    state.dirtyArtifacts.clear();
    window.localStorage.setItem("discoveryProjectId", state.project.id);
    window.history.replaceState(null, "", `/?project=${encodeURIComponent(state.project.id)}`);
    render();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      window.localStorage.removeItem("discoveryProjectId");
      window.history.replaceState(null, "", "/");
      return;
    }
    showError(error);
    render();
  }
}

render();
async function initializeWorkspace() {
  try {
    await Promise.all([loadProjectHistory(), loadProviderLibrary()]);
  } catch (error) {
    showError(error);
  }
  await restoreProject();
  render();
}

void initializeWorkspace();

window.addEventListener("beforeunload", event => {
  if (!hasUnsavedWork()) return;
  event.preventDefault();
  event.returnValue = "";
});
