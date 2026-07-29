/**
 * "Which tools does this MCP server offer?" — the authoring-time read that lets the canvas OFFER a
 * tool name and its argument names instead of asking an author to retype what they cannot see.
 *
 * Why it exists (#915 follow-up): the `mcpTool` node's tool and its `argumentBindings` keys were
 * both free text. A typo in either binds nothing real and fails at RUN time, not at save — the save
 * gate only asks whether a binding EXISTS, never whether its name is one the tool takes. The
 * integration node closed this with the catalog; an MCP server's equivalent has to be asked for.
 *
 * Three properties make this safe to expose:
 *
 *  1. **It is the same MCP client the worker uses.** `listMcpTools` shares one `withMcpSession`
 *     helper with `callMcpTool`, so the egress hardening cannot drift: `assertEgressAllowed`
 *     (https + public host, resolved) before the token is sent anywhere, the pinning `safeFetch`
 *     transport for every subsequent hop (#592 DNS-rebinding TOCTOU), client always closed.
 *  2. **The credential never crosses this boundary.** `resolveMcpTarget` returns
 *     `{ serverUrl, headers }`; only the tool list is returned. Nothing from the server's response
 *     is echoed near a header value, and no error message carries one (Tier-1 rule 4).
 *  3. **Everything returned is treated as attacker-authored.** A tool name, description and input
 *     schema are written by whoever runs the server — text we hand straight to a browser. So every
 *     string is control-character-stripped and length-capped (the same `sanitizeText` the MCP
 *     registry uses), the list is capped, and an over-large schema is dropped rather than relayed.
 *
 * Read-only: `tools/list` is a discovery call and nothing here invokes a tool.
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  BlockedEgressError,
  ConnectionService,
  MissingConnectionTokenError,
  NeedsReauthError,
  listMcpTools,
  resolveMcpTarget,
} from "@naary/connections";
import type { ConnectionType } from "@naary/connections";
import type { McpToolSummary } from "@naary/dsl";
import { sanitizeText } from "../mcp-registry/registry-sanitize";

/**
 * Connection kinds that can speak MCP. Mirrors `CONNECTION_TYPES.mcpTool` in the web app
 * (apps/web/src/lib/connection-types.ts) — the same three the node's connection picker offers.
 * A `postgres`/`smtp`/`signing` row has no MCP endpoint, and its `serverUrl` is a display host or
 * empty; without this check that would reach `assertEgressAllowed` as garbage and come back as a
 * baffling egress error instead of "this isn't an MCP connection".
 */
const MCP_CONNECTION_TYPES: ReadonlySet<string> = new Set<ConnectionType>([
  "github",
  "atlassian",
  "custom",
]);

/** Caps on what a remote server can make us relay to a browser. */
export const MAX_TOOLS = 200;
export const MAX_TOOL_NAME_CHARS = 120;
export const MAX_TOOL_DESCRIPTION_CHARS = 400;
/** An input schema past this is dropped (the tool still lists — the author just types the names).
 *  Serialized size, so a deeply-nested or property-stuffed schema can't be relayed wholesale. */
export const MAX_INPUT_SCHEMA_BYTES = 64 * 1024;

/** How long we give a server to answer. A user is staring at a select, not a workflow step. */
const LIST_TIMEOUT_MS = 15_000;

/**
 * Swappable I/O seam (the `__connTestDeps` / `__mcpRegistryDeps` pattern), so a test can point the
 * listing at an in-process server without a network or a real connection row. The DEFAULTS are the
 * hardened real thing.
 */
export const __mcpToolsDeps = {
  resolveMcpTarget: (
    tenantId: string,
    connectionId: string,
  ): Promise<{ serverUrl: string; headers: Record<string, string> }> =>
    resolveMcpTarget(tenantId, connectionId),
  listMcpTools,
};

/**
 * Remove the credential we just sent from anything the server sent back.
 *
 * The same rule `ConnectionTestService.redactToken` enforces on a provider's error body, for the
 * same reason: a server that echoes the Authorization header into a tool description would put the
 * tenant's token in an API response — and from there into a browser console, a Sentry breadcrumb,
 * or a support screenshot. "The server put it there, not us" is not an exemption. Values under 8
 * characters are skipped: those are test placeholders, and scrubbing them mangles unrelated text.
 */
function redactToken(text: string, secretValues: string[]): string {
  let out = text;
  for (const value of secretValues) {
    // Both the whole header value and the bare token inside it — a server echoes either.
    for (const c of [value, value.replace(/^\S+\s+/, "")]) {
      if (c.length < 8) continue;
      out = out.split(c).join("[redacted]");
    }
  }
  return out;
}

/**
 * Keep only what a browser needs, and only in a shape we control.
 *
 * A schema is relayed as opaque JSON (the canvas reads `properties`/`required` out of it) but is
 * re-serialized through a size check first, and anything that isn't a JSON object is dropped —
 * a string or array where a schema belongs would just make the option reader guess. The schema is
 * scrubbed through its serialized form, so an echoed credential can't hide in a nested `default`.
 */
function sanitizeTool(
  raw: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  },
  secretValues: string[],
): McpToolSummary | null {
  // REDACT THEN CAP, not the other way round: capping first can cut a credential in half and leave
  // the surviving prefix behind, which the redaction pass would no longer recognise.
  const name = sanitizeText(
    redactToken(typeof raw.name === "string" ? raw.name : "", secretValues),
    MAX_TOOL_NAME_CHARS,
  );
  // A tool with no usable name can't be called or stored — drop it rather than offer a blank row.
  if (!name) return null;
  const description = sanitizeText(
    redactToken(
      typeof raw.description === "string" ? raw.description : "",
      secretValues,
    ),
    MAX_TOOL_DESCRIPTION_CHARS,
  );
  let inputSchema: Record<string, unknown> | undefined;
  const s = raw.inputSchema;
  if (s && typeof s === "object" && !Array.isArray(s)) {
    try {
      const json = JSON.stringify(s);
      if (json !== undefined && json.length <= MAX_INPUT_SCHEMA_BYTES) {
        const scrubbed = redactToken(json, secretValues);
        inputSchema = JSON.parse(scrubbed) as Record<string, unknown>;
      }
    } catch {
      // Circular / non-serializable — not something we can hand to a browser.
      inputSchema = undefined;
    }
  }
  return { name, description, ...(inputSchema ? { inputSchema } : {}) };
}

@Injectable()
export class McpToolsService {
  constructor(private readonly connections: ConnectionService) {}

  /** The tools `connectionId`'s server advertises, sanitized and capped. */
  async list(
    tenantId: string,
    connectionId: string,
  ): Promise<McpToolSummary[]> {
    const conn = await this.connections.getById(tenantId, connectionId);
    if (!conn) {
      throw new NotFoundException(`Unknown connection '${connectionId}'`);
    }
    if (!MCP_CONNECTION_TYPES.has(conn.type)) {
      throw new BadRequestException(
        `Connection '${conn.label}' is a ${conn.type} connection, which has no MCP endpoint to list tools from.`,
      );
    }
    if (!conn.serverUrl?.trim()) {
      throw new BadRequestException(
        `Connection '${conn.label}' has no Server URL — set the MCP endpoint on the connection, then try again.`,
      );
    }

    let target: { serverUrl: string; headers: Record<string, string> };
    try {
      // Resolved here, held in memory for the one session, and NEVER returned (Tier-1 rule 4).
      target = await __mcpToolsDeps.resolveMcpTarget(tenantId, connectionId);
    } catch (e) {
      throw toHttp(e, conn.label);
    }

    try {
      const raw = await withTimeout(
        __mcpToolsDeps.listMcpTools({
          serverUrl: target.serverUrl,
          headers: target.headers,
        }),
        LIST_TIMEOUT_MS,
      );
      const secretValues = Object.values(target.headers);
      const out: McpToolSummary[] = [];
      const seen = new Set<string>();
      for (const t of raw) {
        const tool = sanitizeTool(t, secretValues);
        if (!tool || seen.has(tool.name)) continue;
        seen.add(tool.name);
        out.push(tool);
        if (out.length >= MAX_TOOLS) break;
      }
      // Alphabetical: `tools/list` order is the server's, and a stable order is what makes a long
      // select usable. Sorted here so every caller gets the same list.
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      throw toHttp(e, conn.label);
    }
  }
}

/**
 * Fail the listing rather than leave a request hanging on a server that accepted the socket and
 * went quiet. `Promise.race` — the MCP client owns its own transport, so there is no request to
 * abort from here; the session is closed by `listMcpTools`'s own `finally` when it eventually
 * settles.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new McpListTimeoutError(`No answer within ${ms / 1000}s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

class McpListTimeoutError extends Error {}

/**
 * Map a failure to a clean HTTP error.
 *
 * An UNKNOWN error's message is deliberately NOT echoed: an MCP transport error can carry the
 * request's headers or a URL with a credential in it, which is exactly how a token ends up in a
 * browser console or a Sentry breadcrumb. Our own typed errors carry no secret, so those speak.
 */
function toHttp(e: unknown, label: string): Error {
  if (
    e instanceof NeedsReauthError ||
    e instanceof MissingConnectionTokenError
  ) {
    return new BadRequestException(
      `Connection '${label}' needs to be (re)authorized before its tools can be listed.`,
    );
  }
  if (e instanceof BlockedEgressError) {
    return new BadRequestException(
      `Blocked by the egress policy (${e.message}) — an MCP server must be a public https host.`,
    );
  }
  if (e instanceof McpListTimeoutError) {
    return new ServiceUnavailableException(
      `'${label}' did not answer within ${LIST_TIMEOUT_MS / 1000}s.`,
    );
  }
  return new ServiceUnavailableException(
    `Could not list tools from '${label}' — the server did not answer a tools/list request.`,
  );
}
