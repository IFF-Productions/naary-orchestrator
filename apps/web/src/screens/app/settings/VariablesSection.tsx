// Global Variables ($vars) section of the Settings screen.
import { Button, Card } from "../../../components";
import type { Variable } from "../../../lib/api";
import { inputStyle } from "./shared";

export function VariablesSection({
  variables,
  loaded,
  varBusy,
  varError,
  newVar,
  setNewVar,
  patchVarValue,
  saveVariable,
  addVariable,
  removeVariable,
}: {
  variables: Variable[];
  loaded: boolean;
  varBusy: boolean;
  varError: string | null;
  newVar: { key: string; value: string };
  setNewVar: React.Dispatch<
    React.SetStateAction<{ key: string; value: string }>
  >;
  patchVarValue: (key: string, value: string) => void;
  saveVariable: (key: string, value: string) => Promise<boolean>;
  addVariable: () => Promise<void>;
  removeVariable: (key: string) => Promise<void>;
}) {
  return (
    <>
      <div
        className="mono"
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--ink-3)",
          margin: "24px 0 12px",
        }}
      >
        Variables
      </div>
      <div
        style={{
          fontSize: "var(--text-body)",
          lineHeight: "var(--leading-snug)",
          color: "var(--ink-2)",
          marginBottom: 12,
        }}
      >
        Reusable, non-secret values for this workspace + environment — reference
        them in any node's fields as <code>{"{{ $vars.KEY }}"}</code>. Scoped to
        the active environment, so the same key can hold a different value in
        sandbox vs prod. Not for secrets (API keys, tokens).
      </div>
      <Card style={{ padding: 18, marginBottom: 12 }}>
        {varError && (
          <div
            style={{
              marginBottom: 12,
              fontSize: "var(--text-sm)",
              color: "var(--state-error)",
            }}
          >
            {varError}
          </div>
        )}
        {variables.length === 0 && loaded && (
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
              marginBottom: 12,
            }}
          >
            No variables yet — add one below.
          </div>
        )}
        {variables.map((v) => (
          <div
            key={v.key}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <code
              style={{
                flex: "0 0 34%",
                fontSize: "var(--text-sm)",
                color: "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={v.key}
            >
              {v.key}
            </code>
            <input
              value={v.value}
              onChange={(e) => patchVarValue(v.key, e.target.value)}
              placeholder="value"
              style={{ ...inputStyle, flex: 1 }}
              disabled={!loaded || varBusy}
            />
            <Button
              variant="secondary"
              disabled={!loaded || varBusy}
              onClick={() => void saveVariable(v.key, v.value)}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              icon="trash"
              disabled={!loaded || varBusy}
              title={`Delete ${v.key}`}
              onClick={() => void removeVariable(v.key)}
            >
              Delete
            </Button>
          </div>
        ))}
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: variables.length ? 14 : 0,
            paddingTop: variables.length ? 14 : 0,
            borderTop: variables.length ? "1px solid var(--line)" : "none",
          }}
        >
          <input
            value={newVar.key}
            onChange={(e) => setNewVar((n) => ({ ...n, key: e.target.value }))}
            placeholder="KEY"
            style={{ ...inputStyle, flex: "0 0 34%" }}
            disabled={!loaded || varBusy}
          />
          <input
            value={newVar.value}
            onChange={(e) =>
              setNewVar((n) => ({ ...n, value: e.target.value }))
            }
            placeholder="value"
            style={{ ...inputStyle, flex: 1 }}
            disabled={!loaded || varBusy}
          />
          <Button
            variant="primary"
            loading={varBusy}
            disabled={!loaded || !newVar.key.trim()}
            onClick={() => void addVariable()}
          >
            Add
          </Button>
        </div>
      </Card>
    </>
  );
}
