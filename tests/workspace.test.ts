import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { workspaceRoutes } from "../src/routes/workspace.js";

test("Discovery Workspace serves its same-origin browser assets without server credentials", async () => {
  const app = Fastify();
  await app.register(workspaceRoutes);
  try {
    const page = await app.inject({ method: "GET", url: "/" });
    const script = await app.inject({ method: "GET", url: "/app.js" });
    const guard = await app.inject({ method: "GET", url: "/submission-guard.js" });
    const deletion = await app.inject({ method: "GET", url: "/project-deletion.js" });
    const httpClient = await app.inject({ method: "GET", url: "/http-client.js" });
    const styles = await app.inject({ method: "GET", url: "/styles.css" });

    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"] ?? "", /text\/html/);
    assert.match(page.body, /Discovery Conversation/);
    assert.match(page.body, /Live Product Spec/);
    assert.match(page.body, /Start Product Solution/);
    assert.match(page.body, /Generate PRD Requirement Details/);
    assert.match(page.body, /PRD Artifact/);
    assert.match(page.body, /Figma Prototype Prompt/);
    assert.match(page.body, /Project history/);
    assert.match(page.body, /Project files &amp; cleanup/);
    assert.match(page.body, /API &amp; Model Library/);
    assert.match(page.body, /AI Settings/);
    assert.match(page.body, /ChatGPT Manual Bridge/);
    assert.match(page.body, /Validate &amp; apply response/);
    assert.equal(script.statusCode, 200);
    assert.match(script.body, /\/projects\/\$\{state\.project\.id\}\/messages/);
    assert.match(script.body, /submissionGuard\.begin/);
    assert.match(script.body, /"x-request-id": action\.requestId/);
    assert.match(script.body, /stages\/solution\/start/);
    assert.match(script.body, /artifacts\/prd\/generate/);
    assert.match(script.body, /artifacts\/prd\/confirm/);
    assert.match(script.body, /artifacts\/figma-prompt\/generate/);
    assert.match(script.body, /copy-figma-prompt-button/);
    assert.match(script.body, /loadProjectHistory/);
    assert.match(script.body, /artifacts\/cleanup/);
    assert.match(script.body, /renderSolutionSpec/);
    assert.match(script.body, /\/api\/providers/);
    assert.match(script.body, /manual-bridge\/prompt/);
    assert.match(script.body, /manual-bridge\/apply/);
    assert.match(script.body, /expectedRecordVersion/);
    assert.match(script.body, /apiKeyMasked/);
    assert.doesNotMatch(script.body, /MODELFLARE_API_KEY|OPENAI_API_KEY/);
    assert.equal(guard.statusCode, 200);
    assert.match(guard.body, /Duplicate Request/);
    assert.equal(deletion.statusCode, 200);
    assert.match(deletion.body, /deletedProjectIds/);
    assert.equal(httpClient.statusCode, 200);
    assert.match(httpClient.body, /options\.body != null/);
    assert.equal(styles.statusCode, 200);
    assert.match(styles.body, /grid-template-columns/);
    assert.match(styles.body, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  } finally {
    await app.close();
  }
});
