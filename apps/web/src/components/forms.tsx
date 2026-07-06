import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { Icon, type IconName } from "./Icon";

/* ---------------- Button ---------------- */
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "positive";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconRight?: IconName;
  block?: boolean;
  iconOnly?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconRight,
  block,
  iconOnly,
  children,
  className,
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
  return (
    <button className={cls} {...rest}>
      {icon && <Icon name={icon} size={isz} strokeWidth={2} />}
      {children}
      {iconRight && <Icon name={iconRight} size={isz} strokeWidth={2} />}
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
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange?.(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

/* ---------------- Checkbox ---------------- */
export function Checkbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={`check${checked ? " checked" : ""}`}
      onClick={() => onChange?.(!checked)}
    >
      <Icon name="check" size={12} strokeWidth={3} />
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
