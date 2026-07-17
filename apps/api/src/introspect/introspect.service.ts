import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import { BlockedEgressError, safeFetch } from "@naary/connections";
import { parse as parseYaml } from "yaml";
import {
  GRAPHQL_INTROSPECTION_QUERY,
  type GraphQLSchemaSummary,
  type OpenApiSummary,
  parseIntrospection,
  parseOpenApi,
} from "@naary/dsl";

// A spec/endpoint is arbitrary user input → guard aggressively. safeFetch already blocks
// private/reserved hosts + enforces https + pins the IP (SSRF); we add an outer timeout and a
// hard response-byte cap so a malicious/huge endpoint can't hang or OOM the control plane.
const FETCH_TIMEOUT_MS = 10_000;
const MAX_SPEC_BYTES = 5 * 1024 * 1024; // 5 MB — generous for a spec, bounded for safety

/**
 * Authoring-time introspection (roadmap: OpenAPI/Swagger + GraphQL autocomplete). Fetches a
 * user-supplied spec/endpoint through the SSRF-guarded safeFetch and parses it with the PURE dsl
 * parsers. SECURITY: this is effectively an SSRF proxy, so the route is tenant-auth-guarded and the
 * caller's `headers` are forwarded **verbatim** — we NEVER resolve `{{ $secrets.NAME }}` here. A user
 * pasting their own bearer token to a URL they typed owns both; decrypting a STORED secret to an
 * arbitrary host would be one-request exfiltration. Env secrets live only in the worker, never here.
 */
@Injectable()
export class IntrospectService {
  /** Fetch + parse an OpenAPI 3.x / Swagger 2.0 spec (JSON or YAML) into an operation list. */
  async openapi(
    url: string,
    headers?: Record<string, string>,
  ): Promise<OpenApiSummary> {
    const raw = await this.fetchCapped(url, { headers });
    // Content-type is unreliable (many specs are served as text/plain), so we sniff by parsing:
    // JSON first (fast, and valid JSON is valid YAML anyway), then YAML. YAML decodes to the same
    // plain-object shape parseOpenApi already handles — decoding stays here, the dsl parser stays pure.
    let spec: unknown;
    try {
      spec = JSON.parse(raw);
    } catch {
      try {
        spec = parseYaml(raw);
      } catch {
        throw new BadRequestException(
          "That spec isn't valid JSON or YAML — point at a JSON or YAML OpenAPI/Swagger spec URL.",
        );
      }
    }
    return parseOpenApi(spec);
  }

  /** Run the standard GraphQL introspection query and summarize the schema. */
  async graphql(
    url: string,
    headers?: Record<string, string>,
  ): Promise<GraphQLSchemaSummary> {
    const raw = await this.fetchCapped(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify({ query: GRAPHQL_INTROSPECTION_QUERY }),
    });
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new BadRequestException(
        "The endpoint did not return a JSON introspection response.",
      );
    }
    return parseIntrospection(data);
  }

  /** safeFetch with an outer timeout + a streamed byte cap. `headers` are forwarded VERBATIM. */
  private async fetchCapped(
    url: unknown,
    opts: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<string> {
    if (typeof url !== "string" || url.trim() === "") {
      throw new BadRequestException("A spec/endpoint URL is required.");
    }
    let res: Response;
    try {
      res = (await safeFetch(url, {
        method: opts.method ?? "GET",
        headers: { accept: "application/json", ...(opts.headers ?? {}) },
        body: opts.body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      } as never)) as unknown as Response;
    } catch (e) {
      // Match by name too — `instanceof` can miss across a module/mock boundary (duplicate class
      // instances), and misclassifying an egress block as a generic 400 would only weaken the message.
      if (
        e instanceof BlockedEgressError ||
        (e instanceof Error && e.name === "BlockedEgressError")
      ) {
        throw new BadRequestException(
          "That URL isn't allowed — it must be a public https host (private/reserved addresses are blocked).",
        );
      }
      throw new BadRequestException(
        "Could not reach that URL (check it's a reachable https endpoint).",
      );
    }
    return this.readCapped(res);
  }

  /** Read a response body up to MAX_SPEC_BYTES, aborting the stream if it's exceeded. */
  private async readCapped(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_SPEC_BYTES) {
            await reader.cancel();
            throw new PayloadTooLargeException(
              "That spec/response is too large to introspect (over 5 MB).",
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  }
}
