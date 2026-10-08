import assert from "node:assert/strict";
import test from "node:test";
import { createRequestHeaders } from "../src/web/http-client.js";

test("bodyless DELETE does not claim to contain JSON", () => {
  const headers = createRequestHeaders({ method: "DELETE" } as RequestInit);

  assert.equal(headers.has("content-type"), false);
});

test("JSON requests still receive the default content type", () => {
  const headers = createRequestHeaders({ method: "POST", body: "{}" } as RequestInit);

  assert.equal(headers.get("content-type"), "application/json");
});

test("an explicit content type is preserved", () => {
  const headers = createRequestHeaders({
    method: "POST",
    body: "plain text",
    headers: { "content-type": "text/plain" }
  } as RequestInit);

  assert.equal(headers.get("content-type"), "text/plain");
});
