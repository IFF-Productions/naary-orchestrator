import type { CSSProperties, ReactNode } from "react";

/**
 * A visual approximation of how Slack renders a Block Kit `blocks` array — the exact payload the
 * worker POSTs (built by `@naary/notifications`). NOT Slack; a faithful-enough preview so we can
 * eyeball formatting (header, the 2-column section fields, full-width sections, action buttons)
 * without a real Slack workspace. Supported blocks: `header`, `section` (mrkdwn `fields`/`text`),
 * `actions` (url buttons).
 *
 * Matched against a real Naary alert (Slack DARK theme): message sits inline with NO card border,
 * inline `code` renders as warm-orange monospace in a thin box. `theme` defaults to "dark" — the
 * theme most workspaces (and this user's) run — with a light variant for completeness. Slack's
 * theme follows the VIEWER's Slack, not our app, so this is its own switch, independent of the
 * Storybook toolbar.
 */

type SlackText = {
  type: "plain_text" | "mrkdwn";
  text: string;
  emoji?: boolean;
};
type SlackButton = {
  type: "button";
  text: SlackText;
  url?: string;
  style?: "primary" | "danger";
};
type SlackBlock =
  | { type: "header"; text: SlackText }
  | { type: "section"; text?: SlackText; fields?: SlackText[] }
  | { type: "actions"; elements: SlackButton[] };

type SlackTheme = "dark" | "light";

// Real Slack surface colours per theme. Message background, text, the distinctive orange inline
// `code`, and link blue — sampled from Slack itself so the preview reads as the real client.
const THEMES: Record<
  SlackTheme,
  {
    surface: string;
    text: string;
    strong: string;
    muted: string;
    link: string;
    code: string;
    codeBg: string;
    codeBorder: string;
    btnBg: string;
    btnText: string;
    btnBorder: string;
    primary: string;
    danger: string;
  }
> = {
  dark: {
    surface: "#1a1d21",
    text: "#d1d2d3",
    strong: "#f4f4f5",
    muted: "#9a9b9e",
    link: "#1d9bd1",
    code: "#e0913a", // Slack dark inline-code orange
    codeBg: "rgba(224,145,58,0.10)",
    codeBorder: "rgba(224,145,58,0.32)",
    btnBg: "transparent",
    btnText: "#d1d2d3",
    btnBorder: "#5c5f66",
    primary: "#007a5a",
    danger: "#e01e5a",
  },
  light: {
    surface: "#ffffff",
    text: "#1d1c1d",
    strong: "#1d1c1d",
    muted: "#616061",
    link: "#1264a3",
    code: "#c2410c",
    codeBg: "rgba(29,28,29,0.04)",
    codeBorder: "rgba(29,28,29,0.13)",
    btnBg: "#ffffff",
    btnText: "#1d1c1d",
    btnBorder: "#d5d6d9",
    primary: "#007a5a",
    danger: "#e01e5a",
  },
};

type Palette = (typeof THEMES)[SlackTheme];

const MONO = "Monaco, Menlo, Consolas, 'Courier New', monospace";

/** Render a tiny subset of Slack mrkdwn: `*bold*`, `` `code` ``, `<url|label>` links, and `\n`. */
function Mrkdwn({ text, c }: { text: string; c: Palette }): ReactNode {
  const lines = text.split("\n");
  return lines.map((line, li) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: static, non-reordering mrkdwn lines
    <span key={li}>
      {li > 0 && <br />}
      {renderInline(line, c)}
    </span>
  ));
}

// The formatter (@naary/notifications.slackEscape) emits &amp;/&lt;/&gt; so Slack mrkdwn treats
// them as literal chars — Slack then DECODES the entities for display. Do the same here, else the
// preview shows literal "&lt;" where Slack shows "<". Decode &amp; LAST so "&amp;lt;" → "&lt;".
function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function renderInline(line: string, c: Palette): ReactNode[] {
  const out: ReactNode[] = [];
  // Tokenize on <url|label> links, *bold*, and `code`, in one pass.
  const re = /<([^>|]+)\|([^>]+)>|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(decode(line.slice(last, m.index)));
    if (m[1]) {
      out.push(
        <a
          // biome-ignore lint/suspicious/noArrayIndexKey: stable within a single render
          key={k++}
          href={m[1]}
          style={{ color: c.link, textDecoration: "none" }}
        >
          {decode(m[2])}
        </a>,
      );
    } else if (m[3]) {
      out.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: stable within a single render
        <strong key={k++} style={{ fontWeight: 700, color: c.strong }}>
          {decode(m[3])}
        </strong>,
      );
    } else if (m[4]) {
      out.push(
        <code
          // biome-ignore lint/suspicious/noArrayIndexKey: stable within a single render
          key={k++}
          style={{
            color: c.code,
            background: c.codeBg,
            border: `1px solid ${c.codeBorder}`,
            borderRadius: 4,
            padding: "1px 4px",
            fontSize: "0.92em",
            fontFamily: MONO,
            wordBreak: "break-all",
          }}
        >
          {decode(m[4])}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(decode(line.slice(last)));
  return out;
}

function Button({ btn, c }: { btn: SlackButton; c: Palette }) {
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "9px 14px",
    borderRadius: 4,
    fontSize: 14,
    fontWeight: 700,
    lineHeight: "16px",
    cursor: "pointer",
    textDecoration: "none",
    border: `1px solid ${c.btnBorder}`,
    background: c.btnBg,
    color: c.btnText,
  };
  if (btn.style === "primary") {
    style.background = c.primary;
    style.color = "#fff";
    style.border = `1px solid ${c.primary}`;
  } else if (btn.style === "danger") {
    style.background = "transparent";
    style.color = c.danger;
    style.border = `1px solid ${c.danger}`;
  }
  // A url-less button (shouldn't happen from the real formatter, but blocks are untyped input)
  // renders as a non-navigable span rather than an <a> with an undefined href.
  return btn.url ? (
    <a href={btn.url} style={style}>
      {btn.text.text}
    </a>
  ) : (
    <span style={style}>{btn.text.text}</span>
  );
}

export function SlackMessage({
  blocks,
  botName = "Naary",
  time = "9:07 AM",
  theme = "dark",
}: {
  blocks: unknown[];
  botName?: string;
  time?: string;
  theme?: SlackTheme;
}) {
  const c = THEMES[theme];
  const list = blocks as SlackBlock[];
  return (
    <div
      style={{
        maxWidth: 640,
        background: c.surface,
        // Real Slack messages have NO card border — they sit inline in the channel.
        padding: "10px 16px 12px",
        fontFamily:
          "Lato, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: c.text,
        display: "flex",
        gap: 10,
      }}
    >
      <div
        aria-hidden
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          flex: "none",
          background: "linear-gradient(135deg,#4a154b,#611f69)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 800,
          fontSize: 16,
        }}
      >
        {botName.slice(0, 1)}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontWeight: 900, fontSize: 15, color: c.strong }}>
            {botName}
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: c.muted,
              border: `1px solid ${c.btnBorder}`,
              borderRadius: 3,
              padding: "1px 4px",
              textTransform: "uppercase",
              letterSpacing: "0.03em",
            }}
          >
            App
          </span>
          <span style={{ fontSize: 12, color: c.muted }}>{time}</span>
        </div>
        <div
          style={{
            marginTop: 4,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {list.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a fixed, ordered payload
            <SlackBlockView key={i} block={b} c={c} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SlackBlockView({ block, c }: { block: SlackBlock; c: Palette }) {
  if (block.type === "header") {
    return (
      <div
        style={{
          fontSize: 18,
          fontWeight: 800,
          lineHeight: "24px",
          color: c.strong,
        }}
      >
        {block.text.text}
      </div>
    );
  }
  if (block.type === "section") {
    const fields = block.fields;
    return (
      <div>
        {block.text && (
          <div style={{ fontSize: 15, lineHeight: "22px" }}>
            <Mrkdwn text={block.text.text} c={c} />
          </div>
        )}
        {fields && (
          // Slack lays section `fields` out in a 2-column grid.
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "10px 16px",
              marginTop: 2,
            }}
          >
            {fields.map((f, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered fields
                key={i}
                style={{ fontSize: 15, lineHeight: "22px", minWidth: 0 }}
              >
                <Mrkdwn text={f.text} c={c} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (block.type === "actions") {
    return (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
        {block.elements.map((el, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered buttons
          <Button key={i} btn={el} c={c} />
        ))}
      </div>
    );
  }
  return null;
}
