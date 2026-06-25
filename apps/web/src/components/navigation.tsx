import { Fragment, type ReactNode } from "react";
import { Icon } from "./Icon";

/* ---------------- Tabs ---------------- */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { value: T; label: string }[];
  active: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={t.value === active}
          className={t.value === active ? "active" : ""}
          onClick={() => onChange(t.value)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Breadcrumb ---------------- */
export function Breadcrumb({ items }: { items: ReactNode[] }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        fontSize: 12.5,
        color: "var(--ink-3)",
      }}
    >
      {items.map((it, i) => (
        <Fragment key={i}>
          {i > 0 && <Icon name="chevron-right" size={13} />}
          <span
            style={{ color: i === items.length - 1 ? "var(--ink)" : undefined }}
          >
            {it}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/* ---------------- Pagination ---------------- */
export function Pagination({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button
        className="btn btn-secondary btn-sm btn-icon"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <Icon name="arrow-left" size={14} />
      </button>
      <span
        className="mono"
        style={{ fontSize: 11.5, color: "var(--ink-2)", padding: "0 6px" }}
      >
        {page} / {pages}
      </span>
      <button
        className="btn btn-secondary btn-sm btn-icon"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        <Icon name="arrow-right" size={14} />
      </button>
    </div>
  );
}
