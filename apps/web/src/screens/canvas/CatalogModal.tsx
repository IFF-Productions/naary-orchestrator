/**
 * In-canvas node catalog modal (redesign: Canvas Authoring Loop, "+" rail tile) —
 * the full browsable catalog as an overlay Dialog: search + category chips +
 * card grid + the per-node detail drawer, all reusing the /app/catalog derivation
 * layer (catalog-data / Glyph / NodeDetailDrawer). "Add" drops the node on the
 * canvas (via onAdd) and closes the modal so the new node is visible.
 */
import { useEffect, useMemo, useState } from "react";
import {
  CATALOG,
  CATEGORIES,
  type CatalogEntry,
  type CategoryId,
  categoryCount,
  categoryOf,
} from "../app/catalog/catalog-data";
import { GlyphTile } from "../app/catalog/Glyph";
import { NodeDetailDrawer } from "../app/catalog/NodeDetailDrawer";

export function CatalogModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  /** Add this entry to the canvas (the caller also closes the modal + toasts). */
  onAdd: (entry: CatalogEntry) => void;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<CategoryId | "all">("all");
  const [sel, setSel] = useState<string | null>(null);

  // Fresh state each open.
  useEffect(() => {
    if (open) {
      setQ("");
      setCat("all");
      setSel(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (sel) setSel(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, sel, onClose]);

  const query = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (query) {
      return CATALOG.filter((e) =>
        `${e.name} ${e.desc} ${categoryOf(e.category).name}`
          .toLowerCase()
          .includes(query),
      );
    }
    if (cat !== "all") return CATALOG.filter((e) => e.category === cat);
    return CATALOG;
  }, [query, cat]);
  const selEntry = sel ? (CATALOG.find((e) => e.id === sel) ?? null) : null;

  if (!open) return null;

  return (
    <div className="overlay" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Node catalog"
        onClick={(e) => e.stopPropagation()}
        style={{
          margin: "auto",
          width: "min(980px, calc(100vw - 40px))",
          height: "min(660px, calc(100dvh - 64px))",
          background: "var(--panel)",
          border: "1px solid var(--line-mid)",
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow-raised)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "naaryPopIn 0.22s ease",
        }}
      >
        {/* header: title + search + close */}
        <div
          style={{
            flex: "none",
            padding: "14px 18px 12px",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ flex: "none" }}>
            <div
              style={{
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-bold)",
                letterSpacing: "var(--tracking-tight)",
              }}
            >
              Node catalog
            </div>
            <div
              style={{ fontSize: "var(--text-xs)", color: "var(--ink-faint)" }}
            >
              {CATALOG.length} nodes · click Add to drop one on the canvas
            </div>
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search nodes…"
            aria-label="Search nodes"
            // biome-ignore lint/a11y/noAutofocus: search is the modal's primary action
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              height: 36,
              background: "var(--card)",
              border: "1px solid var(--line-2)",
              borderRadius: 9,
              padding: "0 12px",
              fontSize: "var(--text-body)",
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
            }}
          />
          <button
            type="button"
            aria-label="Close catalog"
            onClick={onClose}
            style={{
              width: 32,
              height: 32,
              flex: "none",
              borderRadius: 8,
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink-2)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
            >
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* category chip strip */}
        <div
          style={{
            flex: "none",
            display: "flex",
            gap: 5,
            overflowX: "auto",
            padding: "9px 18px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          {(
            [
              {
                id: "all" as const,
                name: "All",
                color: "var(--brand)",
                count: CATALOG.length,
              },
              ...CATEGORIES.map((c) => ({ ...c, count: categoryCount(c.id) })),
            ] as {
              id: CategoryId | "all";
              name: string;
              color: string;
              count: number;
            }[]
          ).map((c) => {
            const active = !query && cat === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setCat(c.id);
                  setQ("");
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  flex: "none",
                  padding: "5px 11px",
                  borderRadius: 999,
                  border: `1px solid ${
                    active
                      ? "color-mix(in srgb, var(--brand) 30%, transparent)"
                      : "var(--line-2)"
                  }`,
                  background: active ? "var(--brand-soft)" : "var(--card)",
                  color: active ? "var(--ink)" : "var(--ink-2)",
                  fontSize: "var(--text-sm)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: c.color,
                    flex: "none",
                  }}
                />
                {c.name}
                <span
                  className="mono"
                  style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
                >
                  {c.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* grid + detail drawer */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            position: "relative",
            display: "flex",
          }}
        >
          <div
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: "auto",
              padding: "16px 18px 20px",
            }}
          >
            {results.length > 0 ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(196px, 1fr))",
                  gap: 11,
                }}
              >
                {results.map((n) => {
                  const color = categoryOf(n.category).color;
                  const selected = sel === n.id;
                  return (
                    <div
                      key={n.id}
                      role="button"
                      tabIndex={0}
                      aria-label={n.name}
                      onClick={() => setSel(n.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSel(n.id);
                        }
                      }}
                      style={{
                        border: `1px solid ${selected ? "var(--brand)" : "var(--line-mid)"}`,
                        background: "var(--card)",
                        borderRadius: 13,
                        padding: 13,
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <GlyphTile
                          path={n.ipath}
                          color={color}
                          tile={32}
                          glyph={16}
                          radius={9}
                        />
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: "var(--weight-semibold)",
                            color: "var(--ink)",
                            flex: 1,
                            lineHeight: 1.2,
                          }}
                        >
                          {n.name}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "var(--ink-faint)",
                          lineHeight: 1.5,
                          minHeight: 34,
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {n.desc}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                        }}
                      >
                        <span
                          className="mono"
                          style={{
                            fontSize: "var(--text-2xs)",
                            color: "var(--ink-3)",
                            letterSpacing: "0.02em",
                          }}
                        >
                          {n.inputs.length} in · {n.outputs.length} out
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onAdd(n);
                          }}
                          aria-label={`Add ${n.name} to canvas`}
                          style={{
                            marginLeft: "auto",
                            fontSize: "var(--text-xs)",
                            color: "var(--brand)",
                            fontWeight: "var(--weight-semibold)",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            padding: "3px 5px",
                            borderRadius: 6,
                          }}
                        >
                          + Add
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                style={{
                  padding: "56px 20px",
                  textAlign: "center",
                  color: "var(--ink-3)",
                  fontSize: "var(--text-sm)",
                }}
              >
                No nodes match “{q.trim()}” — try a broader term, or use an HTTP
                Request or Code node to call anything.
              </div>
            )}
          </div>

          {selEntry && (
            <NodeDetailDrawer
              entry={selEntry}
              phone={false}
              onAdd={onAdd}
              onClose={() => setSel(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
