import "./config/load-env.js";
import Fastify from "fastify";
import { createAIProvider } from "./ai/provider-factory.js";
import { FileProjectRepository } from "./repositories/file-project-repository.js";
import { projectRoutes } from "./routes/projects.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { providerRoutes } from "./routes/providers.js";
import { RuntimeService } from "./runtime/runtime-service.js";
import { PrdService } from "./prd/prd-service.js";
import { FigmaPromptService } from "./figma/figma-prompt-service.js";
import { InteractionService } from "./interaction/interaction-service.js";
import { RequestProgressStore } from "./runtime/request-progress.js";

const app = Fastify({ logger: true });
const repo = new FileProjectRepository();
const providerSelection = createAIProvider();
await providerSelection.initialize();
const ai = providerSelection.provider;
const requestProgress = new RequestProgressStore();
const runtime = new RuntimeService(repo, ai, requestProgress);
const prd = new PrdService(repo, ai);
const interaction = new InteractionService(repo, ai);
const figmaPrompt = new FigmaPromptService(repo, ai);

app.get("/health", async () => {
  const active = providerSelection.library.getState().active;
  return {
    ok: true,
    provider: active.name,
    providerId: active.kind === "codex" ? "codex" : "relay",
    profileId: active.id,
    profile: active.name,
    model: active.activeModel || "CLI default",
    status: providerSelection.info.status
  };
});
await app.register(workspaceRoutes);
await app.register(providerRoutes, { library: providerSelection.library });
await app.register(projectRoutes, { repo, runtime, prd, interaction, figmaPrompt, requestProgress });

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST?.trim() || "127.0.0.1";
await app.listen({ port, host });
const activeProvider = providerSelection.library.getState().active;
app.log.info({
  provider: activeProvider.name,
  profileId: activeProvider.id,
  model: activeProvider.activeModel || "CLI default",
  status: providerSelection.info.status
}, "AI Provider Ready");
