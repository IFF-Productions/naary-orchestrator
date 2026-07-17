// httpRequest + graphQL config sections of the node inspector (extracted verbatim from CanvasPage).
import type { ConfigSectionCtx } from "./ConfigPanel";
import { CurlImportButton } from "../../canvas/CurlImportButton";
import { GraphQLIntrospectButton } from "../../canvas/GraphQLIntrospectButton";
import { OpenApiImportButton } from "../../canvas/OpenApiImportButton";
import { api } from "../../lib/api";
import {
  type BindingRow,
  BindingsEditor,
  CONNECTION_TYPES,
  ConnectionSelect,
  inputStyle,
  JsonField,
  Labeled,
} from "./fields";

export function renderHttpRequestSection(c: ConfigSectionCtx) {
  const {
    node,
    kind,
    config,
    str,
    num,
    obj,
    exprText,
    onChange,
    upstreamIds,
    edges,
    nodeKinds,
    connections,
    pins,
  } = c;
  return (
    <>
      {kind === "httpRequest" && (
        <>
          <CurlImportButton
            onApply={(c) =>
              onChange({
                method: c.method,
                url: c.url,
                headers: c.headers ?? {},
                query: c.query ?? {},
                body: c.body,
              })
            }
          />
          <OpenApiImportButton
            onApply={(c) =>
              // Always write query/headers (empty when the operation declares none) so a
              // re-import is idempotent — mirrors the cURL import above; a conditional
              // spread would retain stale values from a previous import/edit.
              onChange({
                method: c.method,
                url: c.url,
                query: c.query ?? {},
                headers: c.headers ?? {},
              })
            }
          />
          <Labeled label="Method">
            <select
              value={str("method") || "GET"}
              onChange={(e) => onChange({ method: e.target.value })}
              style={inputStyle}
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="URL">
            {exprText("url", {
              placeholder: "https://api.example.com/v1/things",
            })}
          </Labeled>

          <BindingsEditor
            bindings={
              obj("argumentBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ argumentBindings: v })}
          />

          <JsonField
            label="Query params (JSON)"
            value={obj("query")}
            placeholder={'{\n  "q": "open"\n}'}
            onChange={(v) => onChange({ query: v })}
          />
          <JsonField
            label="Headers (JSON, non-secret)"
            value={obj("headers")}
            placeholder={'{\n  "Accept": "application/json"\n}'}
            onChange={(v) => onChange({ headers: v })}
          />
          <JsonField
            label="Body (JSON)"
            value={obj("body")}
            placeholder={'{\n  "title": "hello"\n}'}
            onChange={(v) => onChange({ body: v })}
          />

          <Labeled label="Auth connection id (optional)">
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES[kind] ?? []}
              value={str("connectionId")}
              onChange={(id) => onChange({ connectionId: id })}
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Auth is attached server-side from the connection — never put tokens
            in the headers above (they'd be stored in the run history).
          </div>

          <Labeled label="Timeout (ms)">
            <input
              type="number"
              min={1}
              value={num("timeoutMs") ?? ""}
              onChange={(e) =>
                onChange({
                  timeoutMs: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="30000 (default)"
            />
          </Labeled>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(config.failOnErrorStatus)}
              onChange={(e) =>
                onChange({ failOnErrorStatus: e.target.checked })
              }
            />
            Fail the node on status ≥ 400 (otherwise branch on{" "}
            <code>.status</code>)
          </label>

          <Labeled label="Cost (USD per call)">
            <input
              type="number"
              min={0}
              step={0.001}
              value={num("costUsd") ?? ""}
              onChange={(e) =>
                onChange({
                  costUsd: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              style={inputStyle}
              placeholder="0.00"
            />
          </Labeled>

          {/* Pagination — auto-follow pages; the loop runs in the activity, so the
              node returns the combined items. Every page URL is egress-guarded. */}
          {(() => {
            const pg = config.pagination as
              | {
                  mode?: "cursor" | "page" | "url";
                  itemsPath?: string;
                  cursorPath?: string;
                  cursorParam?: string;
                  pageParam?: string;
                  startPage?: number;
                  nextUrlPath?: string;
                  stopOnEmpty?: boolean;
                  maxPages?: number;
                }
              | undefined;
            const on = Boolean(pg);
            const mode = pg?.mode ?? "cursor";
            const setPg = (patch: Record<string, unknown> | undefined) =>
              onChange({ pagination: patch });
            return (
              <div
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: "var(--radius-md)",
                  padding: 10,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <label
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    fontSize: "var(--text-sm)",
                    color: "var(--ink-2)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      setPg(e.target.checked ? { mode: "cursor" } : undefined)
                    }
                  />
                  Paginate — fetch all pages, return the combined items
                </label>
                {on && (
                  <>
                    <Labeled label="Pagination style">
                      <select
                        value={mode}
                        onChange={(e) => setPg({ ...pg, mode: e.target.value })}
                        style={inputStyle}
                      >
                        <option value="cursor">
                          Cursor / token in the response
                        </option>
                        <option value="page">Increment a page number</option>
                        <option value="url">Follow a next-page URL</option>
                      </select>
                    </Labeled>
                    <Labeled label="Items path (dotted; blank = whole body)">
                      <input
                        value={pg?.itemsPath ?? ""}
                        onChange={(e) =>
                          setPg({
                            ...pg,
                            itemsPath: e.target.value || undefined,
                          })
                        }
                        style={inputStyle}
                        placeholder="data"
                      />
                    </Labeled>
                    {mode === "cursor" && (
                      <>
                        <Labeled label="Cursor path (in the response)">
                          <input
                            value={pg?.cursorPath ?? ""}
                            onChange={(e) =>
                              setPg({
                                ...pg,
                                cursorPath: e.target.value || undefined,
                              })
                            }
                            style={inputStyle}
                            placeholder="meta.next_cursor"
                          />
                        </Labeled>
                        <Labeled label="Cursor query param">
                          <input
                            value={pg?.cursorParam ?? ""}
                            onChange={(e) =>
                              setPg({
                                ...pg,
                                cursorParam: e.target.value || undefined,
                              })
                            }
                            style={inputStyle}
                            placeholder="cursor"
                          />
                        </Labeled>
                      </>
                    )}
                    {mode === "page" && (
                      <>
                        <Labeled label="Page query param">
                          <input
                            value={pg?.pageParam ?? ""}
                            onChange={(e) =>
                              setPg({
                                ...pg,
                                pageParam: e.target.value || undefined,
                              })
                            }
                            style={inputStyle}
                            placeholder="page"
                          />
                        </Labeled>
                        <Labeled label="First page number">
                          <input
                            type="number"
                            min={0}
                            value={pg?.startPage ?? ""}
                            onChange={(e) =>
                              setPg({
                                ...pg,
                                startPage: e.target.value
                                  ? Number(e.target.value)
                                  : undefined,
                              })
                            }
                            style={inputStyle}
                            placeholder="1"
                          />
                        </Labeled>
                      </>
                    )}
                    {mode === "url" && (
                      <Labeled label="Next-URL path (absolute URL in the response)">
                        <input
                          value={pg?.nextUrlPath ?? ""}
                          onChange={(e) =>
                            setPg({
                              ...pg,
                              nextUrlPath: e.target.value || undefined,
                            })
                          }
                          style={inputStyle}
                          placeholder="links.next"
                        />
                      </Labeled>
                    )}
                    <Labeled label="Max pages (safety cap, ≤ 100)">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={pg?.maxPages ?? ""}
                        onChange={(e) =>
                          setPg({
                            ...pg,
                            maxPages: e.target.value
                              ? Number(e.target.value)
                              : undefined,
                          })
                        }
                        style={inputStyle}
                        placeholder="10"
                      />
                    </Labeled>
                    <label
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        fontSize: "var(--text-sm)",
                        color: "var(--ink-2)",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={pg?.stopOnEmpty !== false}
                        onChange={(e) =>
                          setPg({
                            ...pg,
                            stopOnEmpty: e.target.checked ? undefined : false,
                          })
                        }
                      />
                      Stop when a page returns no items
                    </label>
                  </>
                )}
              </div>
            );
          })()}
        </>
      )}

      {kind === "graphQL" && (
        <>
          <Labeled label="Endpoint URL">
            {exprText("url", {
              placeholder: "https://api.example.com/graphql",
            })}
          </Labeled>

          <GraphQLIntrospectButton
            url={str("url")}
            onInsertQuery={(query) => onChange({ query })}
          />

          <Labeled label="Query">
            {exprText("query", {
              multiline: true,
              minHeight: "120px",
              placeholder: "query {\n  __typename\n}",
            })}
          </Labeled>

          <BindingsEditor
            bindings={
              obj("argumentBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ argumentBindings: v })}
          />

          <JsonField
            label="Variables (JSON)"
            value={obj("variables")}
            placeholder={'{\n  "id": "123"\n}'}
            onChange={(v) => onChange({ variables: v })}
          />
          <JsonField
            label="Headers (JSON, non-secret)"
            value={obj("headers")}
            placeholder={'{\n  "Accept": "application/json"\n}'}
            onChange={(v) => onChange({ headers: v })}
          />

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(config.failOnErrors)}
              onChange={(e) => onChange({ failOnErrors: e.target.checked })}
            />
            Fail the node if the response has GraphQL errors (otherwise branch
            on <code>.errors</code>)
          </label>

          <Labeled label="Timeout (ms)">
            <input
              type="number"
              min={1}
              value={num("timeoutMs") ?? ""}
              onChange={(e) =>
                onChange({
                  timeoutMs: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="30000 (default)"
            />
          </Labeled>

          <Labeled label="Cost (USD per call)">
            <input
              type="number"
              min={0}
              step={0.001}
              value={num("costUsd") ?? ""}
              onChange={(e) =>
                onChange({
                  costUsd: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              style={inputStyle}
              placeholder="0.00"
            />
          </Labeled>
        </>
      )}
    </>
  );
}
