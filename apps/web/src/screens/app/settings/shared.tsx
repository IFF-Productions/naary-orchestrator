// Shared form primitives for the Settings screen sections.

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: 16 }}>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
        {label}
      </span>
      <div style={{ marginTop: 6 }}>{children}</div>
    </label>
  );
}

export const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};
