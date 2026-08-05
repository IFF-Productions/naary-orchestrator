import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { Icon, type IconName } from "./Icon";
import { Spinner } from "./Spinner";

/* ---------------- Button ---------------- */
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "positive";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconRight?: IconName;
  block?: boolean;
  iconOnly?: boolean;
  /** Show an inline spinner in place of the leading icon and disable the button. */
  loading?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  block,
  iconOnly,
  loading,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  const cls = [
    "btn",
    `btn-${variant}`,
    size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "",
    iconOnly ? "btn-icon" : "",
    block ? "btn-block" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const isz = size === "sm" ? 14 : size === "lg" ? 16 : 15;
  // Filled variants sit on the brand/state fill, so the spinner needs a light arc/track
  // to read; outline variants use the brand arc on a faint track.
  const filled =
    variant === "primary" || variant === "danger" || variant === "positive";
  return (
    <button
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Spinner
          size={isz}
          color={filled ? "rgba(255,255,255,0.95)" : "var(--brand)"}
          track={filled ? "rgba(255,255,255,0.35)" : "var(--line-2)"}
        />
      ) : (
        icon && <Icon name={icon} size={isz} strokeWidth={2} />
      )}
      {children}
      {iconRight && !loading && (
        <Icon name={iconRight} size={isz} strokeWidth={2} />
      )}
    </button>
  );
}

/* ---------------- Input ---------------- */
interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  large?: boolean;
}
export function TextInput({ large, className, ...rest }: TextInputProps) {
  return (
    <input
      className={["input", large ? "input-lg" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

/* SearchInput — icon + ⌘K hint, matches the topbar search affordance. */
export function SearchInput({
  placeholder = "Search…",
  kbd = "⌘K",
  value,
  onChange,
  onSubmit,
  style,
}: {
  placeholder?: string;
  kbd?: string;
  value?: string;
  onChange?: (v: string) => void;
  /** Fired when the user presses Enter (with the current value). */
  onSubmit?: (v: string) => void;
  style?: React.CSSProperties;
}) {
  return (
    <div className="input-wrap" style={style}>
      <Icon name="search" size={15} style={{ color: "var(--ink-3)" }} />
      <input
        className="bare"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter")
            onSubmit?.((e.target as HTMLInputElement).value);
        }}
      />
      {kbd && <span className="kbd">{kbd}</span>}
    </div>
  );
}

/* ---------------- Select (display) ---------------- */
export function Select({
  value,
  placeholder,
  onClick,
  style,
}: {
  value?: string;
  placeholder?: string;
  onClick?: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button type="button" className="select" onClick={onClick} style={style}>
      <span style={{ color: value ? "var(--ink)" : "var(--ink-3)" }}>
        {value ?? placeholder}
      </span>
      <Icon name="chevron-down" size={14} style={{ color: "var(--ink-2)" }} />
    </button>
  );
}

/* ---------------- Switch ---------------- */
export function Switch({
  checked,
  onChange,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange?.(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

/* ---------------- Checkbox ---------------- */
/**
 * An 18px check tile. `hitArea` grows the TAP TARGET without growing the tile: the button becomes
 * a transparent box of that size and the 18px `.check` moves inside it as presentation.
 *
 * Why the tile has to move inside rather than the button just getting padding: `.check` draws the
 * visual with its own `border` + `background`, so padding the button would inflate the drawn box
 * too. And why real layout rather than a `::after` overlay — an overlay's size is invisible to
 * `getBoundingClientRect`, so an overlay that overlapped its neighbour would measure identical to
 * one that didn't, and the neighbour-spacing audit (`scripts/responsive-audit.mjs`) could never
 * catch it. A laid-out box pushes its siblings instead, which makes overlap impossible and keeps
 * the measurement honest. See the #1076 note at the call site in `Approvals.tsx` for the
 * measured 11px that forced this.
 *
 * The inner tile is `aria-hidden` presentation: the button keeps `role="checkbox"`, so this stays
 * ONE control (a nested interactive element is the bug #511's Settings fix was about).
 *
 * NAME IT. This renders `role="checkbox"` on a `<button>`, whose accessible name comes ONLY from
 * `aria-labelledby` / `aria-label` / its own content — and its content is a decorative tick. Two
 * things that look like they name it do not: a wrapping `<label>` (implicit labelling applies to
 * form controls, not to a `<button>`), and a labelled ancestor row (that names the ROW; the
 * checkbox is a separately focusable child). Measured on the built approvals screen before this:
 * 4 of 4 `role="checkbox"` elements had NO accessible name. Prefer `ariaLabelledBy` pointing at
 * the visible text that already sits beside the box over duplicating that string.
 */
export function Checkbox({
  checked,
  onChange,
  hitArea,
  ariaLabel,
  ariaLabelledBy,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  /** Square hit-area size in px. Omit for the default, where the 18px tile IS the target. */
  hitArea?: number;
  /** Accessible name. Use when there is no visible label to point at. */
  ariaLabel?: string;
  /** Id of the visible element that names this box — preferred over `ariaLabel` when one exists. */
  ariaLabelledBy?: string;
}) {
  const cls = `check${checked ? " checked" : ""}`;
  if (hitArea === undefined) {
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cls}
        onClick={() => onChange?.(!checked)}
      >
        <Icon name="check" size={12} strokeWidth={3} />
      </button>
    );
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      // Moves global.css's `:focus-visible` ring off this transparent box and onto the tile —
      // see the `.check-hit` rules in components.css.
      className="check-hit"
      onClick={() => onChange?.(!checked)}
      style={{
        // NOT `all: "unset"`. That shorthand expands to `outline-style: none` as an INLINE
        // declaration, which beats the UA's `:focus-visible` ring — the class-based branch above
        // never reset `outline`, so reaching for `all` here would have silently removed the focus
        // ring from a control this change exists to make more accessible. (Same cascade fact that
        // made the `min-height` rules in components.css dead, pointing the other way.) So only
        // the properties that actually need resetting are named.
        boxSizing: "border-box",
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: hitArea,
        height: hitArea,
        flex: "none",
      }}
    >
      <span className={cls} aria-hidden>
        <Icon name="check" size={12} strokeWidth={3} />
      </span>
    </button>
  );
}

/* ---------------- Radio ---------------- */
export function Radio({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange?: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={`radio${checked ? " checked" : ""}`}
      onClick={onChange}
    />
  );
}

/* ---------------- Field (label + control) ---------------- */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <label className="field-label">{label}</label>
        {hint}
      </div>
      {children}
    </div>
  );
}
