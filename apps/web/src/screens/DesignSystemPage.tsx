import {
  Button,
  Card,
  Checkbox,
  CodeBlock,
  Icon,
  Logo,
  NodeCard,
  Radio,
  SearchInput,
  SectionLabel,
  Select,
  SegmentedToggle,
  StatusPill,
  Switch,
  Table,
  Tag,
} from "../components";
import { useTheme } from "../theme";

const surfaces = [
  { n: "bg", v: "--bg" },
  { n: "bg-2 / panel", v: "--bg-2" },
  { n: "surface", v: "--surface" },
  { n: "card", v: "--card" },
  { n: "card-2", v: "--card-2" },
  { n: "line", v: "--line" },
];
const inks = [
  { n: "brand", v: "--brand" },
  { n: "brand-2", v: "--brand-2" },
  { n: "ink", v: "--ink" },
  { n: "ink-2", v: "--ink-2" },
  { n: "ink-3", v: "--ink-3" },
];
const states = [
  { n: "Idle", v: "--state-idle" },
  { n: "Running", v: "--brand" },
  { n: "Paused", v: "--state-paused" },
  { n: "Done", v: "--state-done" },
  { n: "Error", v: "--state-error" },
];
const nodes = [
  { n: "Trigger", v: "--node-trigger" },
  { n: "Agent", v: "--node-agent" },
  { n: "MCP Tool", v: "--node-mcp" },
  { n: "Router", v: "--node-router" },
  { n: "Approval", v: "--node-approval" },
  { n: "HTTP", v: "--node-http" },
];

const typeScale = [
  { label: "Heading XL", spec: "28 / 700 / -0.02em", fs: 28, fw: 700 },
  { label: "Page title", spec: "21 / 700", fs: 21, fw: 700 },
  { label: "Section heading", spec: "14 / 600", fs: 14, fw: 600 },
  { label: "Body", spec: "13 / 400", fs: 13, fw: 400 },
];

export function DesignSystemPage() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div
      style={{
        minHeight: "100%",
        background: "var(--bg)",
        color: "var(--ink)",
        paddingBottom: 80,
      }}
    >
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "30px 44px 26px",
          borderBottom: "1px solid var(--line)",
          position: "sticky",
          top: 0,
          background: "var(--bg)",
          zIndex: 5,
        }}
      >
        <Logo size={40} />
        <div style={{ flex: 1 }}>
          <div
            style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em" }}
          >
            Naary Design System
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 2 }}>
            The engineering-instrument language behind the durable agent
            platform.
          </div>
        </div>
        <a className="btn btn-secondary" href="/app">
          Open app
        </a>
        <Button icon={theme === "dark" ? "moon" : "sun"} onClick={toggleTheme}>
          {theme === "dark" ? "Dark" : "Light"}
        </Button>
      </div>

      <div
        style={{
          padding: "34px 44px 0",
          display: "flex",
          flexDirection: "column",
          gap: 42,
          maxWidth: 1240,
        }}
      >
        {/* 01 BRAND */}
        <section>
          <SectionLabel index="01">Brand</SectionLabel>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1.2fr 1fr",
              gap: 18,
            }}
          >
            <Card
              style={{
                display: "flex",
                alignItems: "center",
                gap: 18,
                padding: 26,
              }}
            >
              <Logo size={60} />
              <div>
                <div
                  style={{
                    fontSize: 26,
                    fontWeight: 700,
                    letterSpacing: "-0.02em",
                  }}
                >
                  Naary
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink-2)",
                    marginTop: 3,
                  }}
                >
                  Durable, human-in-the-loop AI workflows.{" "}
                  <span style={{ color: "var(--ink-3)" }}>
                    Naary — “fiery” (نارية).
                  </span>
                </div>
              </div>
            </Card>
            <div
              style={{
                borderRadius: 14,
                overflow: "hidden",
                border: "1px solid var(--line)",
                boxShadow: "var(--shadow-card)",
              }}
            >
              <div
                style={{ height: 72, background: "var(--brand-gradient)" }}
              />
              <div
                style={{
                  background: "var(--card)",
                  padding: "13px 16px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
                  Ember gradient
                </span>
                <span
                  className="mono"
                  style={{ fontSize: 11, color: "var(--ink-3)" }}
                >
                  #FFB347 → #F2622E → #C8331F
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* 02 COLOR */}
        <section>
          <SectionLabel index="02" note="toggle theme to preview light + dark">
            Color tokens
          </SectionLabel>

          <Subhead>Surfaces &amp; lines</Subhead>
          <Swatches items={surfaces} cols={6} />

          <Subhead>Brand &amp; content</Subhead>
          <Swatches items={inks} cols={6} />

          <Subhead note="semantic — running adopts the brand ember">
            Run states
          </Subhead>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5,1fr)",
              gap: 12,
              marginBottom: 22,
            }}
          >
            {states.map((s) => (
              <div
                key={s.n}
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--line)",
                  borderRadius: 11,
                  padding: 13,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 11,
                      height: 11,
                      borderRadius: "50%",
                      background: `var(${s.v})`,
                      boxShadow: `0 0 9px var(${s.v})`,
                    }}
                  />
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.n}</span>
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 8 }}
                >
                  {s.v}
                </div>
              </div>
            ))}
          </div>

          <Subhead>Node types</Subhead>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(6,1fr)",
              gap: 12,
            }}
          >
            {nodes.map((s) => (
              <div
                key={s.n}
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--line)",
                  borderRadius: 11,
                  padding: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                }}
              >
                <span
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    background: `color-mix(in srgb, var(${s.v}) 16%, transparent)`,
                    color: `var(${s.v})`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flex: "none",
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="4" fill="currentColor" />
                  </svg>
                </span>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 11.5,
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {s.n}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 9.5, color: "var(--ink-3)" }}
                  >
                    {s.v}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 03 TYPOGRAPHY */}
        <section>
          <SectionLabel index="03">Typography</SectionLabel>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 18,
              marginBottom: 18,
            }}
          >
            <Card style={{ padding: 22 }}>
              <div
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--ink-3)",
                  marginBottom: 10,
                }}
              >
                UI / Display — IBM Plex Sans
              </div>
              <div
                style={{
                  fontSize: 34,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                }}
              >
                Durable by design
              </div>
              <div
                style={{ fontSize: 15, color: "var(--ink-2)", marginTop: 6 }}
              >
                Calm, precise, engineered. The quick brown fox.
              </div>
            </Card>
            <Card style={{ padding: 22 }}>
              <div
                className="mono"
                style={{
                  fontSize: 11,
                  color: "var(--ink-3)",
                  marginBottom: 10,
                }}
              >
                Technical / Data — IBM Plex Mono
              </div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 500 }}>
                rs_8f3a · $0.0142
              </div>
              <div
                className="mono"
                style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 8 }}
              >
                category: "refund_request"
                <br />
                confidence: 0.94 · 1,840 tok
              </div>
            </Card>
          </div>
          <Card style={{ padding: "8px 22px" }}>
            {typeScale.map((t, i) => (
              <div
                key={t.label}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  padding: "12px 0",
                  borderBottom:
                    i < typeScale.length - 1
                      ? "1px solid var(--line)"
                      : undefined,
                }}
              >
                <span style={{ fontSize: t.fs, fontWeight: t.fw }}>
                  {t.label}
                </span>
                <span
                  className="mono"
                  style={{ fontSize: 11, color: "var(--ink-3)" }}
                >
                  {t.spec}
                </span>
              </div>
            ))}
          </Card>
        </section>

        {/* 04 COMPONENTS */}
        <section>
          <SectionLabel index="04">Components</SectionLabel>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}
          >
            <Card>
              <Label>Buttons</Label>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <Button variant="primary">Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="danger">Danger</Button>
                <Button variant="positive" icon="check">
                  Approve
                </Button>
                <Button
                  variant="secondary"
                  icon="plus"
                  iconOnly
                  aria-label="Add"
                />
              </div>
            </Card>

            <Card>
              <Label>Status pills</Label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
                <StatusPill state="idle" />
                <StatusPill state="running" />
                <StatusPill state="paused" />
                <StatusPill state="done" />
                <StatusPill state="error" />
              </div>
              <Label style={{ marginTop: 18 }}>Inputs</Label>
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <SearchInput />
                <Select value="Claude Opus 4.8" />
                <div
                  style={{
                    display: "flex",
                    gap: 16,
                    alignItems: "center",
                    paddingTop: 2,
                  }}
                >
                  <span
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <Checkbox checked onChange={() => {}} />
                    <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                      Checkbox
                    </span>
                  </span>
                  <span
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <Radio checked onChange={() => {}} />
                    <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                      Radio
                    </span>
                  </span>
                </div>
              </div>
            </Card>

            <Card>
              <Label>Node card</Label>
              <NodeCard
                type="agent"
                title="Classify email"
                output="{category, confidence}"
                tags={[
                  { label: "Opus 4.8", accent: true },
                  { label: "$0.009" },
                ]}
                selected
              />
            </Card>

            <Card>
              <Label>Mode toggle &amp; switch</Label>
              <div style={{ marginBottom: 16 }}>
                <SegmentedToggle
                  options={[
                    { value: "edit", label: "Edit" },
                    { value: "run", label: "Run" },
                  ]}
                  value="edit"
                  onChange={() => {}}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <Switch checked onChange={() => {}} />
                <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                  On
                </span>
                <Switch checked={false} onChange={() => {}} />
                <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
                  Off
                </span>
              </div>
            </Card>

            <Card>
              <Label>Table</Label>
              <Table
                rowKey={(r) => r.id}
                columns={[
                  {
                    key: "id",
                    header: "Run",
                    render: (r) => <span className="mono">{r.id}</span>,
                  },
                  {
                    key: "state",
                    header: "State",
                    render: (r) => <StatusPill state={r.state} />,
                  },
                  {
                    key: "cost",
                    header: "Cost",
                    render: (r) => <span className="mono">{r.cost}</span>,
                  },
                ]}
                rows={[
                  { id: "rs_8f3a", state: "running" as const, cost: "$0.0142" },
                  { id: "rs_7c1b", state: "done" as const, cost: "$0.0090" },
                  { id: "rs_5d2e", state: "paused" as const, cost: "$0.0031" },
                ]}
              />
            </Card>

            <Card>
              <Label>Tags &amp; code</Label>
              <div style={{ display: "flex", gap: 7, marginBottom: 14 }}>
                <Tag color="var(--node-agent)">agent</Tag>
                <Tag>refund_request</Tag>
                <Tag color="var(--node-mcp)">mcp · github</Tag>
              </div>
              <CodeBlock>{`{
  "category": "refund_request",
  "confidence": 0.94,
  "tokens": 1840
}`}</CodeBlock>
            </Card>
          </div>
        </section>
      </div>
    </div>
  );
}

function Subhead({
  children,
  note,
}: {
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: "var(--ink-2)",
        marginBottom: 10,
      }}
    >
      {children}
      {note && (
        <span style={{ color: "var(--ink-3)", fontWeight: 400 }}>
          {" "}
          · {note}
        </span>
      )}
    </div>
  );
}

function Label({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, ...style }}>
      {children}
    </div>
  );
}

function Swatches({
  items,
  cols,
}: {
  items: { n: string; v: string }[];
  cols: number;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols},1fr)`,
        gap: 12,
        marginBottom: 22,
      }}
    >
      {items.map((s) => (
        <div key={s.n}>
          <div
            style={{
              height: 58,
              borderRadius: 9,
              background: `var(${s.v})`,
              border: "1px solid var(--line-2)",
            }}
          />
          <div style={{ fontSize: 11.5, fontWeight: 500, marginTop: 7 }}>
            {s.n}
          </div>
          <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            {s.v}
          </div>
        </div>
      ))}
    </div>
  );
}
