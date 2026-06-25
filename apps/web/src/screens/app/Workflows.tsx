import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Icon,
  NODE_ACCENT,
  SearchInput,
  StatusPill,
} from "../../components";
import { workflows, type WorkflowRow } from "../../lib/mock";

const FILTERS = [
  { label: "All", count: 28 },
  { label: "Active", count: 24 },
  { label: "Paused", count: 3 },
  { label: "Failing", count: 1 },
  { label: "Drafts", count: 2 },
];

const GRID = "2.4fr 1fr 1fr .9fr 1fr 40px";

export function Workflows() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("All");
  const [query, setQuery] = useState("");

  return (
    <div style={{ padding: "22px 28px 40px" }}>
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 21,
              fontWeight: 700,
              color: "var(--ink)",
              letterSpacing: "-0.01em",
            }}
          >
            Workflows
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
            28 workflows · 24 active · 1 failing
          </div>
        </div>
        <Button
          variant="primary"
          icon="plus"
          onClick={() => navigate("/app/canvas")}
        >
          New workflow
        </Button>
      </div>

      {/* filter bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: 3,
            gap: 2,
          }}
        >
          {FILTERS.map((f) => {
            const active = f.label === filter;
            return (
              <button
                key={f.label}
                type="button"
                onClick={() => setFilter(f.label)}
                style={{
                  border: "none",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: active ? 600 : 400,
                  color: active ? "var(--ink)" : "var(--ink-2)",
                  background: active ? "var(--card-2)" : "transparent",
                  padding: "5px 12px",
                  borderRadius: 6,
                }}
              >
                {f.label} {f.count}
              </button>
            );
          })}
        </div>
        <SearchInput
          placeholder="Filter by name…"
          kbd=""
          value={query}
          onChange={setQuery}
          style={{ width: 240 }}
        />
        <Button icon="filter" style={{ marginLeft: "auto" }} onClick={() => {}}>
          Sort: Last run
        </Button>
      </div>

      {/* table */}
      <Card pad={false} style={{ overflow: "hidden" }}>
        {/* header row */}
        <div
          className="mono"
          style={{
            display: "grid",
            gridTemplateColumns: GRID,
            gap: 10,
            padding: "10px 18px",
            borderBottom: "1px solid var(--line)",
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            textTransform: "uppercase",
          }}
        >
          <span>Workflow</span>
          <span>Status</span>
          <span>Trigger</span>
          <span>Runs 7d</span>
          <span>Success</span>
          <span />
        </div>
        {workflows.map((w) => (
          <WorkflowRowItem
            key={w.name}
            w={w}
            onOpen={() => navigate("/app/canvas")}
          />
        ))}
      </Card>
    </div>
  );
}

function WorkflowRowItem({
  w,
  onOpen,
}: {
  w: WorkflowRow;
  onOpen: () => void;
}) {
  const accent = NODE_ACCENT[w.accent];
  return (
    <div
      onClick={onOpen}
      style={{
        display: "grid",
        gridTemplateColumns: GRID,
        gap: 10,
        padding: "13px 18px",
        borderBottom: "1px solid var(--line)",
        alignItems: "center",
        cursor: "pointer",
      }}
    >
      {/* workflow name + icon */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          minWidth: 0,
        }}
      >
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "none",
            background: `color-mix(in srgb, ${accent} 16%, transparent)`,
            color: accent,
          }}
        >
          <Icon name="workflow" size={15} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {w.name}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {w.desc}
          </div>
        </div>
      </div>

      {/* status */}
      <span>
        <StatusPill state={w.statusState} label={w.status} />
      </span>

      {/* trigger */}
      <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-2)" }}>
        {w.trigger}
      </span>

      {/* runs */}
      <span className="mono" style={{ fontSize: 12, color: "var(--ink)" }}>
        {w.runs}
      </span>

      {/* success */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            flex: 1,
            height: 5,
            borderRadius: 3,
            background: "var(--line-2)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: w.success,
              background: w.successOk
                ? "var(--state-done)"
                : "var(--state-error)",
            }}
          />
        </div>
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--ink-2)" }}
        >
          {w.success}
        </span>
      </div>

      {/* more */}
      <button
        type="button"
        aria-label="More"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          border: "none",
          background: "transparent",
          color: "var(--ink-3)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="more" size={15} />
      </button>
    </div>
  );
}
