import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ProviderLibraryError, type ProviderLibrary } from "../ai/provider-library.js";

const createProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseURL: z.string().trim().min(1).max(2_000),
  apiKey: z.string().trim().min(1).max(8_000),
  models: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  activeModel: z.string().trim().max(200).optional()
});

const updateProfileSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  baseURL: z.string().trim().min(1).max(2_000).optional(),
  apiKey: z.string().trim().max(8_000).optional(),
  models: z.array(z.string().trim().min(1).max(200)).min(1).max(100).optional(),
  activeModel: z.string().trim().max(200).optional()
});

export async function providerRoutes(app: FastifyInstance, deps: { library: ProviderLibrary }) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid provider configuration", details: error.issues });
    if (error instanceof ProviderLibraryError) return reply.code(error.statusCode).send({ error: error.message });
    app.log.error(error);
    return reply.code(500).send({ error: "Provider configuration failed" });
  });

  app.get("/api/providers", async () => deps.library.getState());

  app.post("/api/providers/decision-extraction", async request => {
    const input = z.object({
      profileId: z.string().trim().min(1),
      model: z.string().trim().min(1).max(200)
    }).parse(request.body);
    return deps.library.configureDecisionExtraction(input.profileId, input.model);
  });

  app.post("/api/providers", async (request, reply) => {
    const input = createProfileSchema.parse(request.body);
    return reply.code(201).send(deps.library.createApiProfile(input));
  });

  app.patch("/api/providers/:id", async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = updateProfileSchema.parse(request.body);
    return deps.library.updateApiProfile(id, input);
  });

  app.post("/api/providers/:id/activate", async request => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { model } = z.object({ model: z.string().trim().max(200).optional() }).parse(request.body ?? {});
    return deps.library.activate(id, model);
  });

  app.delete("/api/providers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    deps.library.deleteProfile(id);
    return reply.code(204).send();
  });
}
