import type { CSSProperties, ReactNode } from "react";

/* ---------------- Card ---------------- */
export function Card({
  children,
  pad = true,
  style,
  className,
  onClick,
}: {
  children: ReactNode;
  pad?: boolean;
  style?: CSSProperties;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={["card", pad ? "card-pad" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      style={style}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

/* ---------------- SectionLabel (numbered mono caption) ---------------- */
export function SectionLabel({
  index,
  children,
  note,
}: {
  index?: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="section-label" style={{ marginBottom: 16 }}>
      {index && <>{index} — </>}
      {children}
      {note && (
        <span
          style={{
            color: "var(--ink-2)",
            textTransform: "none",
            letterSpacing: 0,
            fontWeight: 400,
          }}
        >
          {" "}
          · {note}
        </span>
      )}
    </div>
  );
}

/* ---------------- Brand logo tile ---------------- */
export function Logo({
  size = 30,
  glow = true,
}: {
  size?: number;
  glow?: boolean;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.27,
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--brand-radial)",
        boxShadow: glow ? "0 0 16px -2px rgba(242,98,46,.6)" : undefined,
      }}
    >
      <svg
        width={size * 0.57}
        height={size * 0.57}
        viewBox="0 0 24 24"
        fill="none"
      >
        <path
          d="M12 2.5c.6 3.2 3.4 4.6 3.4 8.2 0 1.3-.5 2.4-1.2 3.2.9-.2 1.7-.9 2.1-1.9.8 1.2 1.2 2.5 1.2 3.8a5.5 5.5 0 0 1-11 0c0-2.6 1.7-4 2.7-5.6.4 1 1.1 1.6 2 1.8-.9-1-1.3-2.1-1.3-3.4 0-2.7 1.6-4 2.3-6.1z"
          fill="#fff3ec"
        />
      </svg>
    </div>
  );
}
