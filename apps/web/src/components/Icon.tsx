import type { CSSProperties } from "react";

/**
 * Outline/line icon set — 1.7px stroke on a 24px viewBox, rounded caps/joins,
 * lucide-adjacent (per the Naary design guidelines). Icons inherit text/accent
 * color via stroke="currentColor". A few solid marks (flame, end square,
 * trigger bolt) render filled.
 */
export type IconName =
  | "grid"
  | "workflow"
  | "activity"
  | "template"
  | "edit"
  | "plug"
  | "chart"
  | "card"
  | "users"
  | "settings"
  | "search"
  | "bell"
  | "plus"
  | "chevron-down"
  | "chevron-right"
  | "chevron-up-down"
  | "expand"
  | "external"
  | "sun"
  | "moon"
  | "check"
  | "check-circle"
  | "x"
  | "eye"
  | "arrow-right"
  | "arrow-left"
  | "play"
  | "pause"
  | "clock"
  | "dollar"
  | "alert"
  | "info"
  | "more"
  | "trash"
  | "copy"
  | "filter"
  | "flame"
  | "bolt"
  | "agent"
  | "mcp"
  | "router"
  | "approval"
  | "http"
  | "end"
  | "sidebar-collapse"
  | "sidebar-expand"
  | "refresh"
  | "key"
  | "logout";

// Each entry is the inner markup of a 24x24 SVG. Stroke icons use currentColor;
// `fill` glyphs set fill explicitly.
const PATHS: Record<IconName, string> = {
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>',
  workflow:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M8.5 6H14a2 2 0 0 1 2 2v1.5M8.5 18H14a2 2 0 0 0 2-2v-1.5" stroke-linecap="round"/>',
  activity:
    '<path d="M3 12h4l2 7 4-16 2 9h6" stroke-linecap="round" stroke-linejoin="round"/>',
  template:
    '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18M9 9v12"/>',
  edit: '<path d="M4 20h4l10-10a2.83 2.83 0 0 0-4-4L4 16v4z" stroke-linejoin="round"/>',
  plug: '<path d="M9 3v5M15 3v5" stroke-linecap="round"/><path d="M7 8h10v3a5 5 0 0 1-10 0V8z" stroke-linejoin="round"/><path d="M12 16v5" stroke-linecap="round"/>',
  chart:
    '<path d="M4 19V5M4 19h16" stroke-linecap="round"/><path d="M8 15l3-4 3 2 4-6" stroke-linecap="round" stroke-linejoin="round"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3 10h18"/>',
  users:
    '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke-linecap="round"/><path d="M16 6a3 3 0 0 1 0 6M17 14.5a5.5 5.5 0 0 1 3.5 4.5" stroke-linecap="round"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1-2.7H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1H9.8a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.8 1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1z" stroke-linejoin="round"/>',
  search:
    '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4" stroke-linecap="round"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9z" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 21a2 2 0 0 0 3 0" stroke-linecap="round"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke-linecap="round"/>',
  "chevron-down":
    '<path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/>',
  "chevron-right":
    '<path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/>',
  "chevron-up-down":
    '<path d="M8 9l4-4 4 4M8 15l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>',
  expand:
    '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" stroke-linecap="round"/>',
  external:
    '<path d="M7 17L17 7M17 7H9M17 7v8" stroke-linecap="round" stroke-linejoin="round"/>',
  sun: '<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" stroke-linecap="round" stroke-linejoin="round"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" stroke-linecap="round" stroke-linejoin="round"/>',
  check:
    '<path d="M5 12l4.5 4.5L19 7" stroke-linecap="round" stroke-linejoin="round"/>',
  "check-circle":
    '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6" stroke-linecap="round" stroke-linejoin="round"/>',
  x: '<path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.6"/>',
  "arrow-right":
    '<path d="M5 12h14M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/>',
  "arrow-left":
    '<path d="M19 12H5M11 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/>',
  play: '<path d="M7 5l12 7-12 7V5z" stroke-linejoin="round"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-linecap="round"/>',
  clock:
    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2" stroke-linecap="round" stroke-linejoin="round"/>',
  dollar:
    '<path d="M12 3v18M16 7a4 3 0 0 0-4-2.5C9.8 4.5 8 5.6 8 7.5S10 10 12 10.5 16 12 16 14s-1.8 3-4 3a4 3 0 0 1-4-2.5" stroke-linecap="round" stroke-linejoin="round"/>',
  alert:
    '<path d="M12 3l9 16H3l9-16z" stroke-linejoin="round"/><path d="M12 10v4M12 17h0" stroke-linecap="round"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h0" stroke-linecap="round"/>',
  more: '<circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none"/>',
  trash:
    '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" stroke-linecap="round" stroke-linejoin="round"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8" stroke-linecap="round"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5z" stroke-linejoin="round"/>',
  flame:
    '<path d="M12 2.5c.6 3.2 3.4 4.6 3.4 8.2 0 1.3-.5 2.4-1.2 3.2.9-.2 1.7-.9 2.1-1.9.8 1.2 1.2 2.5 1.2 3.8a5.5 5.5 0 0 1-11 0c0-2.6 1.7-4 2.7-5.6.4 1 1.1 1.6 2 1.8-.9-1-1.3-2.1-1.3-3.4 0-2.7 1.6-4 2.3-6.1z" fill="currentColor" stroke="none"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" stroke="none"/>',
  agent:
    '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h0M15 13h0" stroke-linecap="round"/><circle cx="12" cy="3" r="1.4" fill="currentColor" stroke="none"/>',
  mcp: '<path d="M5 7l5 5-5 5M12 17h7" stroke-linecap="round" stroke-linejoin="round"/>',
  router:
    '<path d="M12 3v6M12 15v6M3 12h6M15 12h6" stroke-linecap="round"/><circle cx="12" cy="12" r="3"/>',
  approval:
    '<path d="M9 12l2 2 4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 3l7 3v5c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z" stroke-linejoin="round"/>',
  http: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" stroke-linecap="round"/>',
  end: '<rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" stroke="none"/>',
  "sidebar-collapse":
    '<path d="M11 6l-6 6 6 6M19 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/>',
  "sidebar-expand":
    '<path d="M13 6l6 6-6 6M5 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/>',
  refresh:
    '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.6L4 16M4 20v-4h4" stroke-linecap="round" stroke-linejoin="round"/>',
  key: '<circle cx="8" cy="8" r="4"/><path d="M11 11l9 9M17 17l2-2M14 14l2-2" stroke-linecap="round"/>',
  logout:
    '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 12h10M16 8l4 4-4 4M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" stroke-linecap="round" stroke-linejoin="round"/>',
};

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}

export function Icon({
  name,
  size = 17,
  strokeWidth = 1.7,
  className,
  style,
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      className={className}
      style={{ flex: "none", ...style }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}
