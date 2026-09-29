import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIProvider, AIProviderRequest, ModelResponse } from "./provider.js";
import { modelTools } from "../tools/definitions.js";

type JsonSchema = Record<string, unknown>;

interface StructuredTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface CodexInvocation {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  outputPath: string;
}

export interface CodexCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type CodexRunner = (invocation: CodexInvocation, timeoutMs: number) => Promise<CodexCommandResult>;
type CodexReadinessCheck = () => Promise<void>;

export class CodexProvider implements AIProvider {
  private readonly command: string;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly runtimeRoot: string;
  private readonly runner: CodexRunner;
  private readonly readinessCheck: CodexReadinessCheck;
  private ready = false;

  constructor(options?: {
    command?: string;
    model?: string;
    timeoutMs?: number;
    maxRetries?: number;
    runtimeRoot?: string;
    runner?: CodexRunner;
    readinessCheck?: CodexReadinessCheck;
  }) {
    this.command = options?.command ?? (process.env.CODEX_COMMAND?.trim() || "codex");
    this.model = options?.model ?? (process.env.CODEX_MODEL?.trim() || undefined);
    this.timeoutMs = options?.timeoutMs ?? readBoundedInteger("CODEX_TIMEOUT_MS", 240_000, 10_000, 600_000);
    this.maxRetries = options?.maxRetries ?? readBoundedInteger("CODEX_MAX_RETRIES", 0, 0, 1);
    this.runtimeRoot = options?.runtimeRoot ?? join(tmpdir(), "ai-product-workflow-codex-provider");
    this.runner = options?.runner ?? runCodexCommand;
    this.readinessCheck = options?.readinessCheck ?? (() => checkCodexReady(this.command));
  }

  async initialize(): Promise<void> {
    if (this.ready) return;
    await this.readinessCheck();
    this.ready = true;
  }

  async generate(request: AIProviderRequest): Promise<ModelResponse> {
    await this.initialize();
    const tool = selectStructuredTool(request.toolNames);
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const maxRetries = request.maxRetries ?? this.maxRetries;
    const maxAttempts = maxRetries + 1;
    let retryCount = 0;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
      const attempt = attemptIndex + 1;
      request.onProgress?.({ phase: "PROVIDER_ATTEMPT", attempt, maxAttempts, streaming: false });
      try {
        const parsed = await this.execute(request, tool, timeoutMs);
        const callId = `codex-${randomUUID()}`;
        const calls = tool
          ? [{ callId, name: tool.name, arguments: JSON.stringify(parsed) }]
          : [];
        const text = tool ? "" : readTextResult(parsed);
        request.onProgress?.({
          phase: "PROVIDER_RESPONSE",
          attempt,
          outputTokens: null,
          toolCallCount: calls.length
        });
        return {
          text,
          calls,
          historyItems: tool
            ? [{ type: "function_call", call_id: callId, name: tool.name, arguments: calls[0].arguments }]
            : [{ role: "assistant", content: text }],
          observability: {
            model: this.model ?? "codex-cli-default",
            reasoningEffort: "configured-by-codex-cli",
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            reasoningTokens: null,
            firstTokenTime: null,
            ttftMs: null,
            retryCount,
            finishReason: "completed"
          }
        };
      } catch (error) {
        if (attemptIndex < maxRetries && isRetryableCodexError(error)) {
          retryCount += 1;
          request.onProgress?.({
            phase: "PROVIDER_RETRY",
            attempt: attempt + 1,
            maxAttempts,
            reason: "timeout"
          });
          continue;
        }
        throw error;
      }
    }

    throw new Error("Codex CLI request failed without a result");
  }

  private async execute(request: AIProviderRequest, tool: StructuredTool | undefined, timeoutMs: number): Promise<unknown> {
    await mkdir(this.runtimeRoot, { recursive: true });
    const runtimeDirectory = await mkdtemp(join(this.runtimeRoot, "run-"));
    const schemaPath = join(runtimeDirectory, "output-schema.json");
    const outputPath = join(runtimeDirectory, "output.json");
    const schema = tool?.parameters ?? textOutputSchema;
    const prompt = renderPrompt(request, tool);

    try {
      await writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf8");
      const args = [
        "exec",
        "--sandbox", "read-only",
        "-c", 'approval_policy="never"',
        "-c", 'web_search="disabled"',
        "-c", "allow_login_shell=false",
        "--disable", "shell_tool",
        "--disable", "apps",
        "--disable", "multi_agent",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--skip-git-repo-check",
        "--color", "never",
        "--cd", runtimeDirectory,
        "--output-schema", schemaPath,
        "-o", outputPath,
        ...(this.model ? ["--model", this.model] : []),
        "-"
      ];
      let result: CodexCommandResult;
      try {
        result = await this.runner({ command: this.command, args, cwd: runtimeDirectory, prompt, outputPath }, timeoutMs);
      } catch (error) {
        throw mapSpawnError(error);
      }
      if (result.timedOut) {
        throw new CodexProviderFailure(`Codex CLI request timed out after ${timeoutMs}ms`, true);
      }
      if (result.exitCode !== 0) {
        const detail = conciseProcessDetail(result.stderr || result.stdout);
        if (isAuthenticationFailure(detail)) {
          throw new CodexProviderFailure("Codex CLI login is invalid or expired. Run \"codex login\" and try again.");
        }
        const exit = result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `code ${result.exitCode}`;
        throw new CodexProviderFailure(`Codex CLI exited with ${exit}${detail ? `: ${detail}` : ""}`);
      }

      let raw: string;
      try {
        raw = await readFile(outputPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new CodexProviderFailure("Codex output file was not created");
        }
        throw new CodexProviderFailure("Codex output file could not be read", false, error);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new CodexProviderFailure("Codex output JSON could not be parsed", false, error);
      }
      if (!isObject(parsed)) {
        throw new CodexProviderFailure("Codex structured output schema validation failed: expected an object");
      }
      return parsed;
    } finally {
      await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

class CodexProviderFailure extends Error {
  constructor(message: string, readonly retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodexProviderFailure";
  }
}

const textOutputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string" } }
};

function selectStructuredTool(toolNames: string[]): StructuredTool | undefined {
  if (toolNames.length === 0) return undefined;
  if (toolNames.length !== 1) {
    throw new CodexProviderFailure(`Codex Provider requires exactly one structured tool; received ${toolNames.length}`);
  }
  const tool = modelTools.find(candidate => candidate.name === toolNames[0]) as StructuredTool | undefined;
  if (!tool) throw new CodexProviderFailure(`Codex Provider could not find schema for tool ${toolNames[0]}`);
  return tool;
}

function renderPrompt(request: AIProviderRequest, tool: StructuredTool | undefined): string {
  return [
    request.instructions,
    "",
    "# PROVIDER INPUT ITEMS",
    "Treat the JSON below as the complete model input for this request.",
    JSON.stringify(request.input, null, 2),
    "",
    "# CODEX PROVIDER CONSTRAINTS",
    "Reason about the supplied instructions and input only. Do not inspect files, run commands, call tools, browse, modify files, or perform development work.",
    tool
      ? `Return only the JSON arguments for ${tool.name}. The provider will wrap the object as that tool call; do not add a tool-call envelope or Markdown.`
      : "Return only an object with one string property named text."
  ].join("\n");
}

function readTextResult(value: unknown): string {
  if (!isObject(value) || typeof value.text !== "string") {
    throw new CodexProviderFailure("Codex structured output schema validation failed: text is required");
  }
  return value.text;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapSpawnError(error: unknown): Error {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
    return new CodexProviderFailure("Codex CLI not found. Install Codex and ensure \"codex\" is on PATH.");
  }
  if (error instanceof CodexProviderFailure) return error;
  return new CodexProviderFailure("Codex CLI process could not be started", false, error);
}

function isAuthenticationFailure(message: string): boolean {
  return /not logged in|login required|sign in|authentication|unauthori[sz]ed|credential|401/i.test(message);
}

function conciseProcessDetail(value: string): string {
  const singleLine = value.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  return singleLine.length > 500 ? `${singleLine.slice(0, 497)}...` : singleLine;
}

function isRetryableCodexError(error: unknown): boolean {
  return error instanceof CodexProviderFailure && error.retryable;
}

async function runCodexCommand(invocation: CodexInvocation, timeoutMs: number): Promise<CodexCommandResult> {
  return runChildProcess(invocation.command, invocation.args, invocation.cwd, invocation.prompt, timeoutMs);
}

async function checkCodexReady(command: string): Promise<void> {
  let result: CodexCommandResult;
  try {
    result = await runChildProcess(command, ["login", "status"], tmpdir(), "", 10_000);
  } catch (error) {
    throw mapSpawnError(error);
  }
  if (result.timedOut) throw new CodexProviderFailure("Codex CLI login status check timed out after 10000ms");
  if (result.exitCode === 0) return;
  const detail = conciseProcessDetail(result.stderr || result.stdout);
  if (isCommandNotFound(detail)) {
    throw new CodexProviderFailure("Codex CLI not found. Install Codex and ensure \"codex\" is on PATH.");
  }
  if (isAuthenticationFailure(detail)) {
    throw new CodexProviderFailure("Codex CLI login is invalid or expired. Run \"codex login\" and try again.");
  }
  const exit = result.exitCode === null ? `signal ${result.signal ?? "unknown"}` : `code ${result.exitCode}`;
  throw new CodexProviderFailure(`Codex CLI readiness check failed with ${exit}${detail ? `: ${detail}` : ""}`);
}

async function runChildProcess(
  command: string,
  args: string[],
  cwd: string,
  input: string,
  timeoutMs: number
): Promise<CodexCommandResult> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    // Codex Provider must authenticate through the local Codex login, never an
    // API key inherited from the Relay/server process.
    delete environment.OPENAI_API_KEY;
    delete environment.CODEX_API_KEY;
    delete environment.MODELFLARE_API_KEY;
    // Global npm installs expose Codex as codex.cmd on Windows. Node's direct
    // spawn does not resolve command shims consistently, even though the same
    // command works in cmd.exe. Use the system command processor only for that
    // Windows shim case; native .exe commands remain direct child processes.
    const launch = windowsCommandShim(command, args);
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(input, "utf8");
  });
}

function windowsCommandShim(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || command.toLowerCase().endsWith(".exe")) {
    return { command, args };
  }
  return {
    command: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", command, ...args]
  };
}

function isCommandNotFound(message: string): boolean {
  return /is not recognized as an internal or external command|cannot find the (?:file|path)|could not be found/i.test(message);
}

function readBoundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
