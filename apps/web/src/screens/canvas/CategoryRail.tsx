/**
 * 60px icon-only node-category rail (redesign: Canvas Authoring Loop) — the left
 * edge of the canvas body. One 36px tile per catalog category (same category
 * model as /app/catalog — colors + glyphs come from catalog-data), plus a dashed
 * "+" tile pinned at the bottom that opens the full catalog modal.
 *
 * Clicking a tile opens a popover (menu-pop) anchored right of the rail listing
 * that category's REAL nodes (icon + name + one-line description); clicking one
 * adds it to the canvas exactly like the old palette did.
 */
import { useEffect, useRef, useState } from "react";
import {
  CATALOG,
  CATEGORIES,
  type CatalogEntry,
  type CategoryId,
  categoryOf,
} from "../app/catalog/catalog-data";
import { Glyph, GlyphTile } from "../app/catalog/Glyph";

export function CategoryRail({
  onAdd,
  onOpenCatalog,
}: {
  /** Add this catalog entry to the canvas (the old palette-add path). */
  onAdd: (entry: CatalogEntry) => void;
  /** Open the full catalog modal (the dashed "+" tile). */
  onOpenCatalog: () => void;
}) {
  const [openCat, setOpenCat] = useState<CategoryId | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!openCat) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Element))
        setOpenCat(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenCat(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openCat]);

  const open = openCat ? categoryOf(openCat) : null;
  const items = openCat ? CATALOG.filter((e) => e.category === openCat) : [];

  return (
    <div
      ref={ref}
      aria-label="Node categories"
      style={{
        width: 60,
        flex: "none",
        borderRight: "1px solid var(--line)",
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 7,
        padding: "14px 0",
        position: "relative",
        zIndex: 7,
      }}
    >
      {CATEGORIES.map((c) => {
        const active = openCat === c.id;
        return (
          <button
            key={c.id}
            type="button"
            className="naary-rail-tile"
            title={c.name}
            aria-label={c.name}
            aria-expanded={active}
            onClick={() => setOpenCat(active ? null : c.id)}
            style={{
              width: 36,
              height: 36,
              flex: "none",
              borderRadius: 9,
              border: `1px solid ${
                active
                  ? `color-mix(in srgb, ${c.color} 60%, transparent)`
                  : "var(--line-mid)"
              }`,
              background: active
                ? `color-mix(in srgb, ${c.color} 10%, var(--card))`
                : "var(--card)",
              color: c.color,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <Glyph path={c.ipath} size={16} strokeWidth={1.8} />
          </button>
        );
      })}

      <button
        type="button"
        className="naary-rail-tile"
        title="Browse all nodes"
        aria-label="Browse all nodes"
        onClick={() => {
          setOpenCat(null);
          onOpenCatalog();
        }}
        style={{
          marginTop: "auto",
          width: 36,
          height: 36,
          flex: "none",
          borderRadius: 9,
          border: "1px dashed var(--line-2)",
          background: "transparent",
          color: "var(--ink-3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          fontSize: 18,
          lineHeight: 1,
          padding: 0,
        }}
      >
        +
      </button>

      {/* category popover — anchored right of the rail */}
      {open && (
        <div
          className="menu-pop"
          role="menu"
          aria-label={`${open.name} nodes`}
          style={{
            position: "absolute",
            left: 66,
            top: 10,
            width: 288,
            maxHeight: "min(560px, calc(100dvh - 140px))",
            overflowY: "auto",
            background: "var(--panel)",
            border: "1px solid var(--line-mid)",
            borderRadius: 12,
            boxShadow: "var(--shadow-raised)",
            padding: 6,
            zIndex: 30,
          }}
        >
          <div
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 9px 8px",
              fontSize: "var(--text-2xs)",
              fontWeight: "var(--weight-semibold)",
              letterSpacing: "var(--tracking-label)",
              textTransform: "uppercase",
              color: "var(--ink-3)",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: open.color,
                flex: "none",
              }}
            />
            {open.name}
            <span style={{ marginLeft: "auto", fontWeight: 400 }}>
              {items.length}
            </span>
          </div>
          {items.map((n) => (
            <button
              key={n.id}
              type="button"
              role="menuitem"
              className="naary-rail-item"
              aria-label={n.name}
              title={n.desc}
              onClick={() => {
                onAdd(n);
                setOpenCat(null);
              }}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                width: "100%",
                textAlign: "left",
                padding: "8px 9px",
                borderRadius: 9,
                border: "none",
                background: "transparent",
                color: "var(--ink)",
                cursor: "pointer",
              }}
            >
              <GlyphTile
                path={n.ipath}
                color={open.color}
                tile={28}
                glyph={15}
                radius={8}
                strokeWidth={1.8}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: "var(--text-body)",
                    fontWeight: "var(--weight-semibold)",
                    lineHeight: 1.25,
                  }}
                >
                  {n.name}
                </span>
                <span
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 1,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    lineHeight: 1.45,
                    marginTop: 1,
                  }}
                >
                  {n.desc}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
