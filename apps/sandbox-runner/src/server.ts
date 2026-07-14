import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { RunnerConfig } from "./config";
import {
  BadRequestError,
  type Exec,
  type RunResult,
  runSandbox,
} from "./run-sandbox";

/** Constant-time bearer check (the token gates Docker/host-root access). */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    // Single-shot: a client disconnect mid-upload emits 'aborted'/'close' WITHOUT 'error',
    // so without these the promise would hang forever and leak the handler.
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        req.destroy();
        done(() => reject(new BadRequestError("request body too large")));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () =>
      done(() => resolve(Buffer.concat(chunks).toString("utf8"))),
    );
    req.on("error", (e) => done(() => reject(e)));
    req.on("aborted", () =>
      done(() => reject(new BadRequestError("request aborted"))),
    );
    req.on("close", () =>
      done(() => reject(new BadRequestError("connection closed"))),
    );
  });
}

/**
 * The sandbox-runner HTTP service. ONE endpoint that matters: `POST /run` launches an
 * ephemeral, egress-isolated sandbox for a run and returns the CLI output + diff. Bearer-
 * authed (the runner holds Docker = host-root, so every request is treated as privileged).
 * The tenant key is never echoed into a response or a log.
 */
export function createRunnerServer(cfg: RunnerConfig, exec?: Exec): Server {
  return createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (req.method === "GET" && req.url === "/healthz") {
        return send(200, { ok: true });
      }
      if (req.method !== "POST" || req.url !== "/run") {
        return send(404, { error: "not found" });
      }
      if (!authorized(req, cfg.token)) {
        return send(401, { error: "unauthorized" });
      }

      try {
        const raw = await readBody(req, 8 * 1024 * 1024);
        let parsed: {
          runId?: string;
          agentArgs?: string[];
          anthropicKey?: string;
          timeoutMs?: number;
        };
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new BadRequestError("invalid JSON body");
        }
        const result: RunResult = await runSandbox(
          {
            runId: parsed.runId ?? "",
            agentArgs: parsed.agentArgs ?? [],
            anthropicKey: parsed.anthropicKey ?? "",
            timeoutMs: parsed.timeoutMs,
          },
          cfg,
          exec,
        );
        // Response carries the CLI output + diff — NOT the key.
        return send(200, result);
      } catch (e) {
        if (e instanceof BadRequestError)
          return send(400, { error: e.message });
        // Don't leak an internal error's message (could echo argv/env). Generic 500.
        return send(500, { error: "sandbox run failed" });
      }
    })();
  });
}
