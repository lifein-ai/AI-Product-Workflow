import assert from "node:assert/strict";
import test from "node:test";
import { createProjectRecord } from "../src/domain/factories.js";
import { executeTool } from "../src/tools/executor.js";

test("Discovery may update discovery paths", () => {
  const project = createProjectRecord("PK", "做主播PK");
  executeTool(project, "update_product_spec", {
    expectedRevision: 0,
    operations: [{ op: "REPLACE", path: "discovery.problem", value: { statement: "主播缺少互动" } }],
    summary: "define problem"
  });
  assert.equal(project.productSpec.discovery.problem?.statement, "主播缺少互动");
  assert.equal(project.workflow.stages.DISCOVERY.contentVersion, 1);
});

test("Discovery cannot mutate solution", () => {
  const project = createProjectRecord("PK", "做主播PK");
  assert.throws(() => executeTool(project, "update_product_spec", {
    expectedRevision: 0,
    operations: [{ op: "REPLACE", path: "solution.foo", value: "bar" }],
    summary: "invalid"
  }));
});

test("Discovery accepts JSON Pointer paths and batch appends array values", () => {
  const project = createProjectRecord("PK", "做主播PK");
  executeTool(project, "update_product_spec", {
    expectedRevision: 0,
    operations: [
      { op: "ADD", path: "/discovery/currentProduct/capabilities", value: ["邀请 PK", "观众送礼"] },
      { op: "ADD", path: "discovery/currentProduct/limitations", value: "没有随机匹配" },
      { op: "ADD", path: "currentProduct/problems", value: "使用率未知" },
      { op: "ADD", path: "/discovery/hypotheses", value: [{ id: "gift-signal", statement: "PK 可能提升礼物流水" }] }
    ],
    summary: "Record capabilities and hypothesis"
  });
  assert.deepEqual(project.productSpec.discovery.currentProduct.capabilities, ["邀请 PK", "观众送礼"]);
  assert.deepEqual(project.productSpec.discovery.currentProduct.limitations, ["没有随机匹配"]);
  assert.deepEqual(project.productSpec.discovery.currentProduct.problems, ["使用率未知"]);
  assert.equal(project.productSpec.discovery.hypotheses[0].id, "gift-signal");
});
