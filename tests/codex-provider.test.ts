import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexProvider,
  type CodexCommandResult,
  type CodexInvocation
} from "../src/ai/codex-provider.js";

const completed: CodexCommandResult = {
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false
};

test("Codex Provider runs in an isolated directory and converts structured output to the existing tool-call contract", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "codex-provider-test-"));
  let seen: CodexInvocation | undefined;
  const events: string[] = [];
  try {
    const provider = new CodexProvider({
      runtimeRoot,
      readinessCheck: async () => undefined,
      runner: async invocation => {
        seen = invocation;
        const schema = JSON.parse(await readFile(invocation.args[invocation.args.indexOf("--output-schema") + 1], "utf8"));
        assert.equal(schema.properties.result.enum[0], "GENERATED");
        await writeFile(invocation.outputPath, JSON.stringify({
          result: "GENERATED",
          requirementDetailsMarkdown: "## Valid",
          openQuestions: [],
          generationNotes: []
        }), "utf8");
        return completed;
      }
    });

    const response = await provider.generate({
      instructions: "Use confirmed facts.",
      input: [{ role: "user", content: "Generate the PRD" }],
      toolNames: ["complete_prd_generation"],
      onProgress: event => events.push(event.phase)
    });

    assert.ok(seen);
    assert.notEqual(seen.cwd, process.cwd());
    assert.ok(seen.cwd.startsWith(runtimeRoot));
    assert.ok(seen.args.includes("read-only"));
    assert.ok(seen.args.includes('approval_policy="never"'));
    assert.ok(seen.args.includes("--ignore-user-config"));
    assert.ok(seen.args.includes("--ephemeral"));
    assert.ok(!seen.args.includes("--full-auto"));
    assert.match(seen.prompt, /Do not inspect files, run commands, call tools/);
    assert.equal(response.calls.length, 1);
    assert.equal(response.calls[0].name, "complete_prd_generation");
    assert.equal(JSON.parse(response.calls[0].arguments).requirementDetailsMarkdown, "## Valid");
    assert.deepEqual(events, ["PROVIDER_ATTEMPT", "PROVIDER_RESPONSE"]);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("Codex Provider supports a no-tool smoke call through a minimal structured text schema", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "codex-provider-text-test-"));
  try {
    const provider = new CodexProvider({
      runtimeRoot,
      readinessCheck: async () => undefined,
      runner: async invocation => {
        await writeFile(invocation.outputPath, '{"text":"OK"}', "utf8");
        return completed;
      }
    });
    const response = await provider.generate({ instructions: "Reply OK", input: [], toolNames: [] });
    assert.equal(response.text, "OK");
    assert.deepEqual(response.calls, []);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("Codex Provider fails readiness before starting an inference process", async () => {
  let inferenceStarted = false;
  const provider = new CodexProvider({
    readinessCheck: async () => { throw new Error("Codex CLI login is invalid or expired"); },
    runner: async () => {
      inferenceStarted = true;
      return completed;
    }
  });
  await assert.rejects(
    () => provider.generate({ instructions: "Reply OK", input: [], toolNames: [] }),
    /login is invalid or expired/
  );
  assert.equal(inferenceStarted, false);
});

test("Codex Provider reports command, authentication, timeout, output, JSON, and schema failures", async t => {
  const cases: Array<{
    name: string;
    runner: (invocation: CodexInvocation) => Promise<CodexCommandResult>;
    pattern: RegExp;
  }> = [
    {
      name: "command missing",
      runner: async () => { throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }); },
      pattern: /Codex CLI not found/
    },
    {
      name: "login expired",
      runner: async () => ({ ...completed, exitCode: 1, stderr: "Not logged in. Run codex login." }),
      pattern: /login is invalid or expired/
    },
    {
      name: "timeout",
      runner: async () => ({ ...completed, exitCode: null, signal: "SIGTERM", timedOut: true }),
      pattern: /request timed out/
    },
    {
      name: "non-zero exit",
      runner: async () => ({ ...completed, exitCode: 7, stderr: "runtime failure" }),
      pattern: /exited with code 7/
    },
    {
      name: "missing output",
      runner: async () => completed,
      pattern: /output file was not created/
    },
    {
      name: "invalid JSON",
      runner: async invocation => {
        await writeFile(invocation.outputPath, "not-json", "utf8");
        return completed;
      },
      pattern: /output JSON could not be parsed/
    },
    {
      name: "invalid root schema",
      runner: async invocation => {
        await writeFile(invocation.outputPath, "[]", "utf8");
        return completed;
      },
      pattern: /schema validation failed/
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const runtimeRoot = await mkdtemp(join(tmpdir(), "codex-provider-error-test-"));
      try {
        const provider = new CodexProvider({ runtimeRoot, readinessCheck: async () => undefined, runner: item.runner });
        await assert.rejects(
          () => provider.generate({ instructions: "test", input: [], toolNames: ["complete_prd_generation"] }),
          item.pattern
        );
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
      }
    });
  }
});

test("Codex Provider performs only the configured bounded timeout retry", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "codex-provider-retry-test-"));
  let attempts = 0;
  try {
    const provider = new CodexProvider({
      runtimeRoot,
      maxRetries: 1,
      readinessCheck: async () => undefined,
      runner: async invocation => {
        attempts += 1;
        if (attempts === 1) return { ...completed, exitCode: null, signal: "SIGTERM", timedOut: true };
        await writeFile(invocation.outputPath, '{"text":"OK"}', "utf8");
        return completed;
      }
    });
    const result = await provider.generate({ instructions: "Reply OK", input: [], toolNames: [] });
    assert.equal(result.text, "OK");
    assert.equal(result.observability?.retryCount, 1);
    assert.equal(attempts, 2);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
