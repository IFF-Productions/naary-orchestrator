/**
 * Catalog glyphs — the design's 24-viewbox stroke paths rendered as a plain
 * <svg>, plus the bordered icon tile every catalog surface (rail rows, cards,
 * recents chips, drawer header, toasts) uses. Purely presentational.
 */
import type { CSSProperties } from "react";

export function Glyph({
  path,
  size = 17,
  strokeWidth = 1.7,
  style,
}: {
  path: string;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ flex: "none", ...style }}
      aria-hidden="true"
    >
      <path
        d={path}
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Square outlined tile in the entry's category accent (design: colored border +
 *  colored glyph on transparent). */
export function GlyphTile({
  path,
  color,
  tile,
  glyph,
  radius,
  strokeWidth = 1.7,
}: {
  path: string;
  color: string;
  /** Tile edge in px. */
  tile: number;
  /** Glyph edge in px. */
  glyph: number;
  radius: number;
  strokeWidth?: number;
}) {
  return (
    <span
      style={{
        width: tile,
        height: tile,
        flex: "none",
        borderRadius: radius,
        border: `1px solid ${color}`,
        color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Glyph path={path} size={glyph} strokeWidth={strokeWidth} />
    </span>
  );
}
