import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";

const webRoot = resolve(process.cwd(), "src", "web");

async function asset(name: string): Promise<string> {
  return readFile(resolve(webRoot, name), "utf8");
}

export async function workspaceRoutes(app: FastifyInstance) {
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(await asset("index.html")));
  app.get("/app.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").send(await asset("app.js")));
  app.get("/submission-guard.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").send(await asset("submission-guard.js")));
  app.get("/styles.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(await asset("styles.css")));
  app.get("/favicon.ico", async (_request, reply) => reply.code(204).send());
}
