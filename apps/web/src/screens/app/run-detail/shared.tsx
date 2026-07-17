// Shared layout primitives for the RunDetail screen sections.

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-md)",
        fontWeight: "var(--weight-semibold)",
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

export function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 11,
      }}
    >
      <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
        {label}
      </span>
      {children}
    </div>
  );
}
