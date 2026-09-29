import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

// Load exactly one local file. Explicit process environment variables always win.
const localPath = resolve(process.cwd(), ".env.local");
const fallbackPath = resolve(process.cwd(), ".env");
const selectedPath = existsSync(localPath) ? localPath : existsSync(fallbackPath) ? fallbackPath : undefined;

if (selectedPath) config({ path: selectedPath, override: false });
