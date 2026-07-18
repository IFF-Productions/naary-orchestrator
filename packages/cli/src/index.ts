#!/usr/bin/env node
/**
 * `naary` bin entry. Thin: read the version, build the real (stdout/stderr + real
 * config) context, route, and set the process exit code. All routing/command logic
 * lives in ./run so it can be unit-tested against an injected context.
 *
 * Zero runtime dependencies — Node built-ins only (node:util parseArgs, global fetch,
 * node:fs/path/os). Imports NO server code; it is purely an /api/v1 HTTP client.
 */

import fs from "node:fs";
import path from "node:path";
import { defaultContext } from "./context";
import { run } from "./run";

/**
 * Read our own version from package.json. With rootDir:"src" we cannot `import`
 * the JSON (TS6059), so read it at runtime relative to the built file:
 * dist/index.js → ../package.json.
 */
function readVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const code = await run(argv, defaultContext(), readVersion());
  process.exitCode = code;
}

void main();
