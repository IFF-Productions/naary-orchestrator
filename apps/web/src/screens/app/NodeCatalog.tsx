/**
 * Node catalog screen (redesign, "Naary Node Catalog.dc.html") — the browsable
 * node palette at /app/catalog: left category rail (All + design categories with
 * counts), search with clear + result count, "Recently used" chips (persisted in
 * localStorage), responsive card grid, and a slide-in detail drawer. Every node
 * shown is derived from the REAL registry (see catalog/catalog-data.ts) — the
 * design's illustrative 48-node list is not copied.
 *
 * "Add" deep-links to /app/canvas?add=<nodeType> (the canvas may ignore the
 * param today — it's the seam) after showing the design's bottom-center toast.
 * Keyboard: ↑↓ move the selection, ⏎ adds it, Esc closes the drawer / clears
 * the search (per the design's footer hint row).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HScroll } from "../../components";
import {
  BELOW_DRAWER_QUERY,
  PHONE_QUERY,
  useMediaQuery,
} from "../../lib/useMediaQuery";
import type { CatalogEntry, CategoryId } from "./catalog/catalog-data";
import {
  addToCanvasUrl,
  CATALOG,
  CATEGORIES,
  categoryCount,
  categoryOf,
} from "./catalog/catalog-data";
import { Glyph, GlyphTile } from "./catalog/Glyph";
import { NodeDetailDrawer } from "./catalog/NodeDetailDrawer";

const RECENTS_KEY = "naary.catalog.recents";
const MAX_RECENTS = 4;
/** Toast dwell before the deep link fires (the design's toastIn stays legible). */
const NAVIGATE_DELAY_MS = 700;

// Hover lift / focus ring — inline styles can't express :hover//:focus, so the
// screen carries its own scoped classes. Entrance keyframes (toast/drawer)
// come from the shared tokens.css set (naaryToastIn / naarySlideInRight).
const CSS = `
.nccat-card{transition:border-color .14s,background .14s,transform .14s,box-shadow .14s;}
.nccat-card:hover{background:var(--hover);border-color:var(--line-2);transform:translateY(-2px);box-shadow:0 10px 26px -16px rgba(0,0,0,.7);}
.nccat-row{transition:background .12s,color .12s;}
.nccat-row:hover{background:var(--hover);}
.nccat-search:focus{border-color:var(--brand);box-shadow:var(--focus-ring);outline:none;}
`;

const MONO_LABEL: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--ink-faint)",
  fontFamily: "var(--font-mono)",
  fontWeight: "var(--weight-semibold)",
};

interface ToastItem {
  id: number;
  entry: CatalogEntry;
}

function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((id): id is string => typeof id === "string")
      .filter((id) => CATALOG.some((e) => e.id === id))
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export function NodeCatalog() {
  const navigate = useNavigate();
  const phone = useMediaQuery(PHONE_QUERY);
  /**
   * Touch sizing goes to <= 1024, not just phone: a tablet is a finger too, and #511 sets the
   * threshold there. Kept separate from `phone` (<= 640), which switches LAYOUT — this only
   * changes a hit area.
   */
  const touch = useMediaQuery(BELOW_DRAWER_QUERY);


  const [q, setQ] = useState("");
  const [cat, setCat] = useState<CategoryId | "all">("all");
  const [sel, setSel] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const timers = useRef<number[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  }, [recents]);
  useEffect(() => {
    const pending = timers.current;
  return () => pending.forEach(clearTimeout);
  }, []);

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
  const recentEntries = recents
    .map((id) => CATALOG.find((e) => e.id === id))
    .filter((e): e is CatalogEntry => Boolean(e));

  const addNode = (entry: CatalogEntry) => {
    setRecents((r) =>
      [entry.id, ...r.filter((x) => x !== entry.id)].slice(0, MAX_RECENTS),
    );
    const id = ++toastSeq.current;
    setToasts((t) => [...t, { id, entry }]);
    timers.current.push(
      window.setTimeout(
        () => navigate(addToCanvasUrl(entry)),
        NAVIGATE_DELAY_MS,
      ),
    );
    // Belt-and-braces auto-dismiss in case navigation is interrupted.
    timers.current.push(
      window.setTimeout(
        () => setToasts((t) => t.filter((x) => x.id !== id)),
        2400,
      ),
    );
  };

  // Keyboard: ↑↓ walk the visible results (selection opens the drawer), ⏎ adds
  // the selection, Esc closes the drawer, else clears the search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (sel) setSel(null);
        else if (q) setQ("");
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (results.length === 0) return;
        e.preventDefault();
        const idx = results.findIndex((r) => r.id === sel);
        const next =
          e.key === "ArrowDown"
            ? Math.min(idx + 1, results.length - 1)
            : Math.max(idx - 1, 0);
        setSel(results[next].id);
        return;
      }
      if (e.key === "Enter" && selEntry) {
        e.preventDefault();
        addNode(selEntry);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Keep the keyboard selection visible in the scrolling grid.
  useEffect(() => {
    if (!sel) return;
    gridRef.current
      ?.querySelector(`[data-cid="${CSS_ESCAPE(sel)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const showRecents = !query && cat === "all" && recentEntries.length > 0;
  const resultLabel = query
    ? `${results.length} result${results.length === 1 ? "" : "s"} for “${q.trim()}”`
    : cat === "all"
      ? "All nodes"
      : categoryOf(cat).name;

  const catRows: {
    id: CategoryId | "all";
    name: string;
    color: string;
    ipath: string;
    count: number;
  }[] = [
    {
      id: "all",
      name: "All nodes",
      color: "var(--brand)",
      ipath: "M4 6h16M4 12h16M4 18h16",
      count: CATALOG.length,
    },
    ...CATEGORIES.map((c) => ({ ...c, count: categoryCount(c.id) })),
  ];

    /**
   * The category rows, defined ONCE and rendered by both the desktop rail and the phone chip
   * strip — the two differ only in their container, so duplicating the rows would be two places
   * to update a count or a label.
   */
  const catRail = (
    <>
{catRows.map((c) => {
              const active = !query && cat === c.id;
              return (
                <div
                  key={c.id}
                  className="nccat-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setCat(c.id);
                    setQ("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setCat(c.id);
                      setQ("");
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: "var(--radius-md)",
                    cursor: "pointer",
                    marginBottom: phone ? 0 : 2,
                    flex: "none",
                    background: active ? "var(--brand-soft)" : "transparent",
                    color: active ? "var(--ink)" : "var(--ink-2)",
                    border: `1px solid ${
                      active
                        ? "color-mix(in srgb, var(--brand) 30%, transparent)"
                        : "transparent"
                    }`,
                  }}
                >
                  <GlyphTile
                    path={c.ipath}
                    color={c.color}
                    tile={26}
                    glyph={14}
                    radius={7}
                    strokeWidth={1.8}
                  />
                  <span
                    style={{
                      flex: phone ? "none" : 1,
                      fontSize: "var(--text-body)",
                      fontWeight: "var(--weight-medium)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.name}
                  </span>
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      fontFamily: "var(--font-mono)",
                      color: "var(--ink-3)",
                    }}
                  >
                    {c.count}
                  </span>
                </div>
              );
            })}
    </>
  );

  return (
    <div style={{ padding: phone ? "14px 12px 24px" : "18px 24px 24px" }}>
      <style>{CSS}</style>

      {/* ===== panel ===== */}
      <div
        style={{
          position: "relative",
          background: "var(--panel)",
          border: "1px solid var(--line-mid)",
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow-card)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          height: phone ? "auto" : "calc(100vh - 140px)",
          minHeight: 520,
        }}
      >
        {/* header */}
        <div
          style={{
            flex: "none",
            padding: "20px 24px 16px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: "var(--radius-md)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--brand-radial)",
                boxShadow: "var(--glow-brand)",
                flex: "none",
              }}
            >
              <Glyph
                path="M12 5v14m-7-7h14"
                size={17}
                strokeWidth={2.2}
                style={{ color: "var(--brand-ink)" }}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: "var(--text-lg)",
                  fontWeight: "var(--weight-bold)",
                  color: "var(--ink)",
                  letterSpacing: "var(--tracking-tight)",
                }}
              >
                Node catalog
              </div>
              <div
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--ink-faint)",
                }}
              >
                {CATALOG.length} nodes across {CATEGORIES.length} categories
              </div>
            </div>
          </div>

          {/* search */}
          <div style={{ marginTop: 15, position: "relative" }}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              style={{ position: "absolute", left: 13, top: 12 }}
              aria-hidden="true"
            >
              <circle
                cx="11"
                cy="11"
                r="6.5"
                stroke="var(--ink-faint)"
                strokeWidth="1.8"
              />
              <path
                d="M20 20l-3.5-3.5"
                stroke="var(--ink-faint)"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
            <input
              className="nccat-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${CATALOG.length} nodes — try 'http', 'approval', 'vector', 'slack'…`}
              aria-label="Search nodes"
              style={{
                width: "100%",
                height: 40,
                background: "var(--card)",
                border: "1px solid var(--line-2)",
                borderRadius: 10,
                padding: "0 40px 0 38px",
                fontSize: "var(--text-body)",
                color: "var(--ink)",
                fontFamily: "var(--font-sans)",
                transition: "border-color .15s, box-shadow .15s",
              }}
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ("")}
                aria-label="Clear search"
                style={{
                  position: "absolute",
                  right: 10,
                  top: 9,
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  border: "none",
                  background: "var(--card-2)",
                  color: "var(--ink-faint)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Glyph path="M6 6l12 12M18 6L6 18" size={12} strokeWidth={2} />
              </button>
            )}
          </div>
        </div>

        {/* body */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: phone ? "column" : "row",
            minHeight: 0,
            position: "relative",
          }}
        >
          {/* Category rail: a vertical rail on desktop, a horizontal CHIP STRIP on phone — that
              split is deliberate. What was missing is any sign the strip scrolls: #848 measured
              766px hidden at 390px (68% of it), so two thirds of the categories were unreachable
              as far as the eye could tell. `HScroll` adds the edge fade and leaves the layout
              decision alone. */
          }
          {phone ? (
            <HScroll
              style={{ flex: "none", borderBottom: "1px solid var(--line)" }}
              scrollerStyle={{ display: "flex", gap: 4, padding: "10px 12px" }}
              fade="var(--panel)"
              deps={cat}
            >
              {catRail}
            </HScroll>
          ) : (
            <div
              style={{
                width: 224,
                flex: "none",
                borderRight: "1px solid var(--line)",
                padding: 12,
                overflowY: "auto",
              }}
            >
              {catRail}
            </div>
          )}

          {/* grid */}
          <div
            ref={gridRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "18px 20px 22px",
              minWidth: 0,
            }}
          >
            {showRecents && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ ...MONO_LABEL, marginBottom: 10 }}>
                  Recently used
                </div>
                <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                  {recentEntries.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="nccat-card"
                      onClick={() => addNode(r)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                        border: "1px solid var(--line-mid)",
                        background: "var(--card)",
                        borderRadius: 10,
                        padding: "8px 13px 8px 10px",
                        cursor: "pointer",
                        color: "var(--ink)",
                      }}
                    >
                      <GlyphTile
                        path={r.ipath}
                        color={categoryOf(r.category).color}
                        tile={24}
                        glyph={13}
                        radius={6}
                        strokeWidth={1.8}
                      />
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: "var(--weight-medium)",
                        }}
                      >
                        {r.name}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ ...MONO_LABEL, marginBottom: 12 }}>{resultLabel}</div>

            {results.length > 0 ? (
              <div
                // Keyed by category (search keeps one key so typing doesn't
                // re-trigger) — switching sections fades the grid in.
                key={query ? "search" : cat}
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(196px, 1fr))",
                  gap: 11,
                  animation: "naaryFadeUp .25s ease",
                }}
              >
                {results.map((n) => {
                  const color = categoryOf(n.category).color;
                  const selected = sel === n.id;
                  return (
                    <div
                      key={n.id}
                      data-cid={n.id}
                      className="nccat-card"
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
                        padding: 14,
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        gap: 9,
                        position: "relative",
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
                          tile={34}
                          glyph={17}
                          radius={9}
                        />
                        <span
                          style={{
                            fontSize: 13.5,
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
                          style={{
                            fontSize: "var(--text-2xs)",
                            fontFamily: "var(--font-mono)",
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
                            addNode(n);
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
                            // 40x20 on a touch screen, sitting INSIDE a tile whose own tap opens
                            // the detail drawer — so a near-miss silently does the wrong thing
                            // (#511). The hit area grows; the label does not, so the tile looks
                            // the same. Safe here because the measured nearest neighbour is >= 44px
                            // away; elsewhere in the app it isn't, which is why this is per-surface
                            // rather than the blanket rule the issue originally proposed.
                            ...(touch
                              ? {
                                  minWidth: 44,
                                  minHeight: 44,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                }
                              : {}),
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
              /* empty search state */
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "70px 20px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 13,
                    border: "1px solid var(--line-2)",
                    background: "var(--card)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginBottom: 15,
                  }}
                >
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      cx="11"
                      cy="11"
                      r="6.5"
                      stroke="var(--ink-faint)"
                      strokeWidth="1.8"
                    />
                    <path
                      d="M20 20l-3.5-3.5"
                      stroke="var(--ink-faint)"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <div
                  style={{
                    fontSize: "var(--text-md)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink-soft)",
                  }}
                >
                  No nodes match “{q.trim()}”
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink-faint)",
                    marginTop: 5,
                    maxWidth: 320,
                    lineHeight: 1.5,
                  }}
                >
                  Try a broader term, or{" "}
                  <button
                    type="button"
                    onClick={() => setQ("")}
                    style={{
                      color: "var(--brand)",
                      cursor: "pointer",
                      fontWeight: "var(--weight-semibold)",
                      background: "none",
                      border: "none",
                      padding: 0,
                      fontSize: "inherit",
                      fontFamily: "inherit",
                    }}
                  >
                    clear the search
                  </button>
                  . Can’t find it? Use an{" "}
                  <span style={{ color: "var(--ink-soft)" }}>HTTP Request</span>{" "}
                  or <span style={{ color: "var(--ink-soft)" }}>Code</span> node
                  to call anything.
                </div>
              </div>
            )}
          </div>

          {/* detail drawer */}
          {selEntry && (
            <NodeDetailDrawer
              entry={selEntry}
              phone={phone}
              onAdd={addNode}
              onClose={() => setSel(null)}
            />
          )}
        </div>

        {/* footer */}
        <div
          style={{
            flex: "none",
            borderTop: "1px solid var(--line)",
            padding: "11px 24px",
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontSize: 11.5,
            color: "var(--ink-faint)",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--brand)",
                flex: "none",
              }}
            />
            Click a node to inspect its inputs &amp; outputs · Add drops it on
            the canvas
          </span>
          {!phone && (
            <span
              style={{
                marginLeft: "auto",
                fontFamily: "var(--font-mono)",
                color: "var(--ink-3)",
              }}
            >
              ↑↓ navigate · ⏎ add · esc close
            </span>
          )}
        </div>

        {/* toasts (bottom-center, design toastIn) */}
        <div
          style={{
            position: "absolute",
            bottom: 26,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            flexDirection: "column",
            gap: 9,
            zIndex: 20,
            alignItems: "center",
            pointerEvents: "none",
          }}
        >
          {toasts.map((t) => {
            const color = categoryOf(t.entry.category).color;
            return (
              <div
                key={t.id}
                role="status"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  border:
                    "1px solid color-mix(in srgb, var(--brand) 35%, transparent)",
                  background: "var(--brand-soft)",
                  backdropFilter: "blur(6px)",
                  borderRadius: 11,
                  padding: "11px 16px",
                  boxShadow: "0 18px 40px -18px rgba(0,0,0,.6)",
                  animation: "naaryToastIn .28s cubic-bezier(.2,.9,.3,1.2)",
                }}
              >
                <GlyphTile
                  path={t.entry.ipath}
                  color={color}
                  tile={20}
                  glyph={12}
                  radius={6}
                  strokeWidth={1.9}
                />
                <span
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink)",
                    fontWeight: "var(--weight-medium)",
                  }}
                >
                  {t.entry.name}
                </span>
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--brand)",
                    fontWeight: "var(--weight-semibold)",
                  }}
                >
                  added to canvas
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** CSS.escape with a fallback (ids are simple, but be safe in selectors). */
function CSS_ESCAPE(v: string): string {
  return typeof window !== "undefined" && window.CSS?.escape
    ? window.CSS.escape(v)
    : v.replace(/[^a-zA-Z0-9_:-]/g, "\\$&");
}
