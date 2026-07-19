/**
 * Node detail drawer (design "Naary Node Catalog.dc.html") — the 336px slide-in
 * overlay on the right of the catalog body showing the selected node: icon +
 * name + category dot, description, "Add to canvas" CTA (ember gradient), then
 * Inputs / Outputs / Authentication / Configuration — all derived from the real
 * registry (see catalog-data.ts). The design's cost profile has no registry
 * source, so it is omitted.
 */
import type { CatalogEntry } from "./catalog-data";
import { categoryOf } from "./catalog-data";
import { Glyph, GlyphTile } from "./Glyph";

const MONO_LABEL: React.CSSProperties = {
  fontSize: 10.5,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--ink-faint)",
  fontFamily: "var(--font-mono)",
  fontWeight: "var(--weight-semibold)",
  marginBottom: 9,
};

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  border: "1px solid var(--line-mid)",
  background: "var(--card)",
  borderRadius: "var(--radius-md)",
  padding: "8px 10px",
};

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11.5,
        color: "var(--ink-3)",
        border: "1px dashed var(--line-2)",
        borderRadius: "var(--radius-md)",
        padding: 10,
      }}
    >
      {children}
    </div>
  );
}

export function NodeDetailDrawer({
  entry,
  phone,
  onAdd,
  onClose,
}: {
  entry: CatalogEntry;
  phone: boolean;
  onAdd: (entry: CatalogEntry) => void;
  onClose: () => void;
}) {
  const cat = categoryOf(entry.category);

  return (
    <div
      role="complementary"
      aria-label={`${entry.name} details`}
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: phone ? "min(336px, 94%)" : 336,
        borderLeft: "1px solid var(--line)",
        background: "var(--panel)",
        overflowY: "auto",
        zIndex: 8,
        boxShadow: "-22px 0 50px -26px rgba(0,0,0,.55)",
        animation: "nccatSlideIn .22s ease",
      }}
    >
      {/* header */}
      <div
        style={{
          padding: "18px 18px 16px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 11 }}>
          <GlyphTile
            path={entry.ipath}
            color={cat.color}
            tile={38}
            glyph={19}
            radius={10}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: "var(--weight-bold)",
                color: "var(--ink)",
                letterSpacing: "var(--tracking-tight)",
              }}
            >
              {entry.name}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 3,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: cat.color,
                  flex: "none",
                }}
              />
              <span
                style={{
                  fontSize: 10.5,
                  fontFamily: "var(--font-mono)",
                  color: "var(--ink-3)",
                }}
              >
                {cat.name}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            style={{
              width: 28,
              height: 28,
              flex: "none",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink-2)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Glyph path="M6 6l12 12M18 6L6 18" size={13} strokeWidth={1.9} />
          </button>
        </div>

        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            lineHeight: 1.6,
            marginTop: 12,
          }}
        >
          {entry.desc}
        </div>

        <button
          type="button"
          onClick={() => onAdd(entry)}
          style={{
            width: "100%",
            height: 40,
            marginTop: 14,
            borderRadius: "var(--radius-md)",
            border:
              "1px solid color-mix(in srgb, var(--brand) 40%, transparent)",
            background: "linear-gradient(180deg, var(--brand-2), var(--brand))",
            color: "var(--brand-ink)",
            fontSize: 12.5,
            fontWeight: "var(--weight-bold)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            boxShadow: "var(--shadow-brand)",
          }}
        >
          <Glyph path="M12 5v14m-7-7h14" size={14} strokeWidth={2.2} />
          Add to canvas
        </button>
      </div>

      {/* body */}
      <div
        style={{
          padding: "16px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {/* inputs */}
        <div>
          <div style={MONO_LABEL}>Inputs</div>
          {entry.inputs.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {entry.inputs.map((p) => (
                <div key={p.name} style={ROW}>
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      fontFamily: "var(--font-mono)",
                      color: "var(--ink-soft)",
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {p.name}
                  </span>
                  <span
                    style={{
                      fontSize: "var(--text-2xs)",
                      fontFamily: "var(--font-mono)",
                      color: "var(--ink-3)",
                    }}
                  >
                    {p.type}
                  </span>
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: "var(--weight-bold)",
                      letterSpacing: "0.04em",
                      borderRadius: 5,
                      padding: "2px 6px",
                      flex: "none",
                      color: p.required ? "var(--brand)" : "var(--ink-3)",
                      background: p.required
                        ? "var(--brand-soft)"
                        : "transparent",
                      border: `1px solid ${
                        p.required
                          ? "color-mix(in srgb, var(--brand) 35%, transparent)"
                          : "var(--line-2)"
                      }`,
                    }}
                  >
                    {p.required ? "required" : "optional"}
                  </span>
                </div>
              ))}
            </div>
          ) : entry.entry ? (
            <EmptyNote>No inputs — this node starts a run.</EmptyNote>
          ) : (
            <EmptyNote>No configurable inputs.</EmptyNote>
          )}
        </div>

        {/* outputs */}
        <div>
          <div style={MONO_LABEL}>Outputs</div>
          {entry.outputs.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {entry.outputs.map((p) => (
                <div key={p.name} style={ROW}>
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      fontFamily: "var(--font-mono)",
                      color: "var(--state-done)",
                      flex: 1,
                    }}
                  >
                    {p.name}
                  </span>
                  {p.type && (
                    <span
                      style={{
                        fontSize: "var(--text-2xs)",
                        fontFamily: "var(--font-mono)",
                        color: "var(--ink-3)",
                      }}
                    >
                      {p.type}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyNote>No output — this node ends the branch.</EmptyNote>
          )}
        </div>

        {/* authentication */}
        <div>
          <div style={MONO_LABEL}>Authentication</div>
          {entry.auth ? (
            <div
              style={{ ...ROW, padding: "9px 11px", alignItems: "flex-start" }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                style={{ flex: "none", marginTop: 1 }}
                aria-hidden="true"
              >
                <rect
                  x="5"
                  y="10"
                  width="14"
                  height="10"
                  rx="2"
                  stroke="var(--node-approval)"
                  strokeWidth="1.7"
                />
                <path
                  d="M8 10V7.5a4 4 0 0 1 8 0V10"
                  stroke="var(--node-approval)"
                  strokeWidth="1.7"
                />
              </svg>
              <span
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--ink-soft)",
                  lineHeight: 1.5,
                }}
              >
                {entry.auth}
              </span>
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
              No credentials required.
            </div>
          )}
        </div>

        {/* configuration */}
        {entry.cfg.length > 0 && (
          <div>
            <div style={MONO_LABEL}>Configuration</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {entry.cfg.map((c) => (
                <span
                  key={c}
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-2)",
                    border: "1px solid var(--line-mid)",
                    background: "var(--card)",
                    borderRadius: 6,
                    padding: "4px 9px",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}

        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-faint)",
            lineHeight: 1.5,
            borderTop: "1px solid var(--line)",
            paddingTop: 14,
          }}
        >
          Fields marked{" "}
          <span
            style={{
              color: "var(--brand)",
              fontWeight: "var(--weight-semibold)",
            }}
          >
            required
          </span>{" "}
          must be set — statically or mapped from an upstream node — before the
          workflow can run.
        </div>
      </div>
    </div>
  );
}
