// Variables section (redesign) — the env-column matrix. Variables ($vars) are
// non-secret key/value rows scoped per environment, so the same key can hold a
// different value in sandbox vs prod. The matrix shows Key | one column per
// environment; each cell edits THAT env's value in place (commit on Enter/blur;
// clearing a cell deletes the key from that environment). The row trash removes
// the key from every environment.
import { useEffect, useMemo, useState } from "react";
import { Button, TextInput } from "../../../components";
import {
  type Environment,
  HttpError,
  UnauthorizedError,
} from "../../../lib/api";
import { PHONE_QUERY, useMediaQuery } from "../../../lib/useMediaQuery";
import { envScoped } from "./env-scoped";
import { ErrorLine, panelStyle, SectionHeader, SectionIntro } from "./shared";

/** key → envId → value (absent = not set in that env). */
type Matrix = Record<string, Record<string, string>>;

function friendlyError(e: unknown, fallback: string): string {
  if (e instanceof UnauthorizedError) return "Sign in to edit variables.";
  if (e instanceof HttpError && e.serverMessage) return e.serverMessage;
  return fallback;
}

export function VariablesSection({ envs }: { envs: Environment[] }) {
  const [matrix, setMatrix] = useState<Matrix>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // In-flight cell edits (cellKey = `${key}\0${envId}`) — committed on Enter/blur.
  const [edits, setEdits] = useState<Record<string, string>>({});
  // "Add variable" draft row: the key + one value per env (empty = leave unset).
  const [adding, setAdding] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftVals, setDraftVals] = useState<Record<string, string>>({});

  useEffect(() => {
    if (envs.length === 0) return;
    let live = true;
    (async () => {
      try {
        const perEnv = await Promise.all(
          envs.map((env) => envScoped.listVariables(env.id)),
        );
        if (!live) return;
        const m: Matrix = {};
        envs.forEach((env, i) => {
          for (const v of perEnv[i]) {
            (m[v.key] ??= {})[env.id] = v.value;
          }
        });
        setMatrix(m);
        setLoaded(true);
        setError(null);
      } catch (e) {
        if (live) setError(friendlyError(e, "Could not load variables."));
      }
    })();
    return () => {
      live = false;
    };
  }, [envs]);

  const keys = useMemo(() => Object.keys(matrix).sort(), [matrix]);
  // PHONE (#708): at 390px this matrix hid 200px — 36% of the row — behind a scroller with no
  // affordance, so with three environments the `prod` column (the one that matters most) was
  // off-canvas. Unlike the grant matrices this row IS list-shaped: one key with a handful of
  // per-env values, which stacks into a card without losing the grid's meaning.
  const phone = useMediaQuery(PHONE_QUERY);
  const gridColumns = `minmax(140px, 1.35fr) ${envs
    .map(() => "minmax(90px, 1fr)")
    .join(" ")} 34px`;

  /** Commit one cell: set the env's value, or delete it when cleared. */
  async function commitCell(key: string, env: Environment) {
    const cellKey = `${key}\0${env.id}`;
    const prev = matrix[key]?.[env.id];
    const next = edits[cellKey];
    if (next === undefined) return; // untouched
    const trimmedGone = next === "" && prev !== undefined;
    if (next === (prev ?? "")) {
      setEdits((e) => {
        const { [cellKey]: _drop, ...rest } = e;
        return rest;
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (trimmedGone) {
        await envScoped.deleteVariable(env.id, key);
        setMatrix((m) => {
          const row = { ...(m[key] ?? {}) };
          delete row[env.id];
          const nextM = { ...m };
          if (Object.keys(row).length === 0) delete nextM[key];
          else nextM[key] = row;
          return nextM;
        });
      } else if (next !== "") {
        await envScoped.setVariable(env.id, key, next);
        setMatrix((m) => ({
          ...m,
          [key]: { ...(m[key] ?? {}), [env.id]: next },
        }));
      }
      setEdits((e) => {
        const { [cellKey]: _drop, ...rest } = e;
        return rest;
      });
    } catch (e) {
      setError(
        friendlyError(
          e,
          "Could not save. Keys must be a valid identifier (letters, digits, underscore; not starting with a digit).",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  /** Delete the key from EVERY environment where it is set. */
  async function removeKey(key: string) {
    setBusy(true);
    setError(null);
    try {
      const set = matrix[key] ?? {};
      await Promise.all(
        envs
          .filter((env) => set[env.id] !== undefined)
          .map((env) => envScoped.deleteVariable(env.id, key)),
      );
      setMatrix((m) => {
        const { [key]: _drop, ...rest } = m;
        return rest;
      });
    } catch (e) {
      setError(friendlyError(e, "Could not delete the variable."));
    } finally {
      setBusy(false);
    }
  }

  /** Save the draft row: write each non-empty env value. */
  async function submitDraft() {
    const key = draftKey.trim();
    const targets = envs.filter((env) => (draftVals[env.id] ?? "") !== "");
    if (!key) return;
    if (targets.length === 0) {
      setError("Give the variable a value in at least one environment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await Promise.all(
        targets.map((env) =>
          envScoped
            .setVariable(env.id, key, draftVals[env.id])
            .then(() => env.id),
        ),
      );
      setMatrix((m) => {
        const row = { ...(m[key] ?? {}) };
        for (const envId of saved) row[envId] = draftVals[envId];
        return { ...m, [key]: row };
      });
      setDraftKey("");
      setDraftVals({});
      setAdding(false);
    } catch (e) {
      setError(
        friendlyError(
          e,
          "Could not save. Keys must be a valid identifier (letters, digits, underscore; not starting with a digit).",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const headCellStyle: React.CSSProperties = {
    fontSize: 10.5,
    letterSpacing: ".08em",
    textTransform: "uppercase",
    color: "var(--ink-faint)",
    fontFamily: "var(--font-mono)",
  };

  return (
    <div>
      <SectionHeader
        title="Variables"
        action={
          <Button
            variant="primary"
            icon="plus"
            disabled={!loaded || envs.length === 0}
            onClick={() => setAdding((v) => !v)}
          >
            Add variable
          </Button>
        }
      />
      <SectionIntro>
        Non-secret config referenced in any node field as{" "}
        <code className="mono" style={{ color: "var(--ink-soft)" }}>
          {"{{ $vars.KEY }}"}
        </code>
        . Values can differ per environment — sandbox points at test endpoints,
        prod at live. Edit a cell in place (Enter saves; clearing a cell removes
        the key from that environment). Not for secrets.
      </SectionIntro>

      {error && <ErrorLine>{error}</ErrorLine>}

      <div style={{ ...panelStyle, overflowX: phone ? undefined : "auto" }}>
        <div
          style={{
            minWidth: phone ? undefined : envs.length > 2 ? 560 : 380,
          }}
        >
          {!phone && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: gridColumns,
              gap: 10,
              alignItems: "center",
              padding: "11px 18px",
              borderBottom: "1px solid var(--line)",
              background: "var(--card-2)",
            }}
          >
            <span style={headCellStyle}>Key</span>
            {envs.map((env) => (
              <span key={env.id} style={headCellStyle}>
                {env.name}
              </span>
            ))}
            <span />
          </div>
          )}

          {adding && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: gridColumns,
                gap: 10,
                alignItems: "center",
                padding: "10px 18px",
                borderBottom: "1px solid var(--line)",
                background: "var(--brand-soft)",
              }}
            >
              <TextInput
                className="mono"
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
                placeholder="KEY"
                style={{ height: 32, fontSize: 12 }}
                disabled={busy}
                autoFocus
              />
              {envs.map((env) => (
                <TextInput
                  key={env.id}
                  className="mono"
                  value={draftVals[env.id] ?? ""}
                  onChange={(e) =>
                    setDraftVals((v) => ({ ...v, [env.id]: e.target.value }))
                  }
                  placeholder="—"
                  style={{ height: 32, fontSize: 12 }}
                  disabled={busy}
                />
              ))}
              <Button
                variant="primary"
                size="sm"
                icon="check"
                iconOnly
                aria-label="Save variable"
                loading={busy}
                disabled={!draftKey.trim()}
                onClick={() => void submitDraft()}
              />
            </div>
          )}
          {adding && (
            <div
              style={{
                padding: "6px 18px 10px",
                borderBottom: "1px solid var(--line)",
                background: "var(--brand-soft)",
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                  setDraftKey("");
                  setDraftVals({});
                }}
              >
                Cancel
              </Button>
            </div>
          )}

          {!loaded && !error && (
            <div
              style={{
                padding: "13px 18px",
                fontSize: "var(--text-sm)",
                color: "var(--ink-3)",
              }}
            >
              Loading variables…
            </div>
          )}
          {loaded && keys.length === 0 && !adding && (
            <div
              style={{
                padding: "16px 18px",
                fontSize: "var(--text-sm)",
                color: "var(--ink-3)",
              }}
            >
              No variables yet — add one and give it a value per environment.
            </div>
          )}
          {keys.map((key) => (
            <div
              key={key}
              className="naary-set-row"
              style={
                phone
                  ? {
                      // Card: the key and its delete on one line, then one LABELLED input per
                      // environment. The env name has to travel with the input here — the column
                      // header is gone, and an unlabelled box would be a value with no home.
                      // A 2-col grid: the key and its delete sit on the first line together
                      // (the trash alone on a line below reads as orphaned), then each labelled
                      // env input spans both columns. `order` does the placing, so the JSX below
                      // stays one shape for both layouts.
                      display: "grid",
                      gridTemplateColumns: "1fr auto",
                      gap: 8,
                      alignItems: "center",
                      padding: "12px 16px",
                      borderBottom: "1px solid var(--line)",
                    }
                  : {
                      display: "grid",
                      gridTemplateColumns: gridColumns,
                      gap: 10,
                      alignItems: "center",
                      padding: "8px 18px",
                      borderBottom: "1px solid var(--line)",
                    }
              }
            >
              <span
                className="mono"
                style={{
                  ...(phone ? { order: 0 } : {}),
                  fontSize: 12,
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={key}
              >
                {key}
              </span>
              {envs.map((env) => {
                const cellKey = `${key}\0${env.id}`;
                const value = edits[cellKey] ?? matrix[key]?.[env.id] ?? "";
                const cell = (
                  <input
                    key={env.id}
                    className="mono naary-var-cell"
                    value={value}
                    placeholder="—"
                    disabled={busy}
                    title={`${key} in ${env.name}${matrix[key]?.[env.id] === undefined ? " (not set)" : ""}`}
                    onChange={(e) =>
                      setEdits((ed) => ({ ...ed, [cellKey]: e.target.value }))
                    }
                    onBlur={() => void commitCell(key, env)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        setEdits((ed) => {
                          const { [cellKey]: _drop, ...rest } = ed;
                          return rest;
                        });
                      }
                    }}
                  />
                );
                if (!phone) return cell;
                return (
                  <label
                    key={env.id}
                    style={{
                      order: 2,
                      gridColumn: "1 / -1",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    <span style={{ width: 62, flex: "none" }}>{env.name}</span>
                    {cell}
                  </label>
                );
              })}
              <Button
                variant="ghost"
                size="sm"
                icon="trash"
                iconOnly
                style={phone ? { order: 1 } : undefined}
                aria-label={`Delete ${key} from every environment`}
                title="Delete this key from every environment"
                disabled={busy}
                onClick={() => void removeKey(key)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
