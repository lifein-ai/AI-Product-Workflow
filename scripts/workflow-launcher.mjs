import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = process.cwd();
const runtimeDirectory = join(projectRoot, ".runtime");
const startupLogPath = join(runtimeDirectory, "startup.log");
const serverLogPath = join(runtimeDirectory, "server.log");
const healthUrl = "http://localhost:3000/health";
const appUrl = "http://localhost:3000";
const startupTimeoutMs = 90_000;

mkdirSync(runtimeDirectory, { recursive: true });
writeFileSync(serverLogPath, "", "utf8");

function logStartup(message) {
  appendFileSync(startupLogPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function writeServerOutput(stream, chunk) {
  const text = chunk.toString();
  stream.write(text);
  appendFileSync(serverLogPath, text, "utf8");
  return text;
}

function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore"
  });
}

function openBrowser() {
  const browser = spawn("cmd.exe", ["/d", "/c", "start", "", appUrl], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  browser.unref();
}

async function readHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  timer.unref();
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.ok === true ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const provider = process.env.AI_PROVIDER || "relay";
logStartup(`Launcher monitor started for provider: ${provider}`);
console.log("Starting service. Keep this window open...");
console.log(`Detailed service log: ${serverLogPath}`);
console.log();

const commandShell = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
const service = spawn(commandShell, ["/d", "/s", "/c", "pnpm start"], {
  cwd: projectRoot,
  env: process.env,
  windowsHide: false,
  stdio: ["inherit", "pipe", "pipe"]
});

let serviceExited = false;
let serviceExitCode = null;
let startupFailure = "";
const failurePattern = /Provider initialization failed|Codex CLI (?:login|readiness)|EADDRINUSE|command not found|is not recognized/i;

service.stdout.on("data", chunk => {
  const text = writeServerOutput(process.stdout, chunk);
  if (failurePattern.test(text)) startupFailure = text.trim();
});
service.stderr.on("data", chunk => {
  const text = writeServerOutput(process.stderr, chunk);
  if (failurePattern.test(text)) startupFailure = text.trim();
});
service.once("error", error => {
  startupFailure = `Unable to start pnpm start: ${error.message}`;
  logStartup(startupFailure);
});
service.once("exit", code => {
  serviceExited = true;
  serviceExitCode = code;
  logStartup(`Service process exited with code: ${code ?? "unknown"}`);
});

let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
  terminateProcessTree(service);
});

const deadline = Date.now() + startupTimeoutMs;
let health = null;
while (Date.now() < deadline && !serviceExited && !startupFailure) {
  health = await readHealth();
  if (health) break;
  await delay(500);
}

if (!health) {
  const reason = startupFailure
    ? "Provider initialization failed."
    : serviceExited
      ? `Service exited before becoming ready (code ${serviceExitCode ?? "unknown"}).`
      : `Service did not become ready within ${startupTimeoutMs / 1000} seconds.`;
  logStartup(reason);
  terminateProcessTree(service);
  console.error();
  console.error(`[ERROR] ${reason}`);
  console.error(`See ${serverLogPath} for the complete error.`);
  process.exitCode = interrupted ? 130 : 1;
} else {
  const providerLabel = health.provider || provider;
  logStartup(`Provider ready: ${providerLabel}`);
  console.log();
  console.log("========================");
  console.log(`Provider: ${providerLabel}`);
  console.log("Status: Ready");
  console.log(`Browser: ${appUrl}`);
  console.log("========================");
  console.log();
  if (process.env.WORKFLOW_SKIP_BROWSER !== "1") openBrowser();

  while (!serviceExited) await delay(500);
  process.exitCode = interrupted ? 130 : (serviceExitCode ?? 1);
}
