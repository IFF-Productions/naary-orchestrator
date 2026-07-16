import type { CSSProperties, ReactNode } from "react";

/**
 * A visual approximation of how Slack renders a Block Kit `blocks` array — the exact payload the
 * worker POSTs (built by `@naary/notifications`). This is NOT Slack; it's a faithful-enough preview
 * so we can eyeball formatting (header, the 2-column section fields, action buttons) without a real
 * Slack workspace. Supported blocks: `header`, `section` (mrkdwn `fields`), `actions` (url buttons).
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

// Slack's real palette (Aubergine sidebar aside, the message surface is neutral). Fixed values —
// a Slack message looks the same regardless of our app's dark/light theme.
const SLACK = {
  surface: "#ffffff",
  border: "#e2e2e4",
  text: "#1d1c1d",
  muted: "#616061",
  link: "#1264a3",
  code: "#e01e5a",
  codeBg: "rgba(29,28,29,0.04)",
  btnBorder: "#d5d6d9",
  primary: "#007a5a",
  danger: "#e01e5a",
};

/** Render a tiny subset of Slack mrkdwn: `*bold*`, `` `code` ``, `<url|label>` links, and `\n`. */
function Mrkdwn({ text }: { text: string }): ReactNode {
  const lines = text.split("\n");
  return lines.map((line, li) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: static, non-reordering mrkdwn lines
    <span key={li}>
      {li > 0 && <br />}
      {renderInline(line)}
    </span>
  ));
}

function renderInline(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Tokenize on <url|label> links, *bold*, and `code`, in one pass.
  const re = /<([^>|]+)\|([^>]+)>|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[1]) {
      out.push(
        <a
          // biome-ignore lint/suspicious/noArrayIndexKey: stable within a single render
          key={k++}
          href={m[1]}
          style={{ color: SLACK.link, textDecoration: "none" }}
        >
          {m[2]}
        </a>,
      );
    } else if (m[3]) {
      out.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: stable within a single render
        <strong key={k++} style={{ fontWeight: 700 }}>
          {m[3]}
        </strong>,
      );
    } else if (m[4]) {
      out.push(
        <code
          // biome-ignore lint/suspicious/noArrayIndexKey: stable within a single render
          key={k++}
          style={{
            color: SLACK.code,
            background: SLACK.codeBg,
            border: `1px solid ${SLACK.border}`,
            borderRadius: 3,
            padding: "0 3px",
            fontSize: "0.85em",
            fontFamily: "Monaco, Menlo, Consolas, 'Courier New', monospace",
          }}
        >
          {m[4]}
        </code>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function Button({ btn }: { btn: SlackButton }) {
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    borderRadius: 4,
    fontSize: 14,
    fontWeight: 700,
    lineHeight: "16px",
    cursor: "pointer",
    textDecoration: "none",
    border: `1px solid ${SLACK.btnBorder}`,
    background: "#fff",
    color: SLACK.text,
  };
  if (btn.style === "primary") {
    style.background = SLACK.primary;
    style.color = "#fff";
    style.border = `1px solid ${SLACK.primary}`;
  } else if (btn.style === "danger") {
    style.background = "#fff";
    style.color = SLACK.danger;
    style.border = `1px solid ${SLACK.danger}`;
  }
  return (
    <a href={btn.url} style={style}>
      {btn.text.text}
    </a>
  );
}

export function SlackMessage({
  blocks,
  botName = "Naary",
}: {
  blocks: unknown[];
  botName?: string;
}) {
  const list = blocks as SlackBlock[];
  return (
    <div
      style={{
        maxWidth: 560,
        background: SLACK.surface,
        border: `1px solid ${SLACK.border}`,
        borderRadius: 8,
        padding: "12px 16px 16px",
        fontFamily:
          "Lato, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: SLACK.text,
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
          <span style={{ fontWeight: 800, fontSize: 15 }}>{botName}</span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: SLACK.muted,
              border: `1px solid ${SLACK.border}`,
              borderRadius: 3,
              padding: "1px 4px",
              textTransform: "uppercase",
              letterSpacing: "0.03em",
            }}
          >
            App
          </span>
          <span style={{ fontSize: 12, color: SLACK.muted }}>now</span>
        </div>
        <div
          style={{
            marginTop: 4,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {list.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are a fixed, ordered payload
            <SlackBlockView key={i} block={b} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SlackBlockView({ block }: { block: SlackBlock }) {
  if (block.type === "header") {
    return (
      <div style={{ fontSize: 18, fontWeight: 800, lineHeight: "24px" }}>
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
            <Mrkdwn text={block.text.text} />
          </div>
        )}
        {fields && (
          // Slack lays section `fields` out in a 2-column grid.
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "8px 16px",
              marginTop: 2,
            }}
          >
            {fields.map((f, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered fields
                key={i}
                style={{ fontSize: 15, lineHeight: "20px", minWidth: 0 }}
              >
                <Mrkdwn text={f.text} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (block.type === "actions") {
    return (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
        {block.elements.map((el, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered buttons
          <Button key={i} btn={el} />
        ))}
      </div>
    );
  }
  return null;
}
