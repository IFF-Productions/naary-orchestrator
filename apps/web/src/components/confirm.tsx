/**
 * In-app confirmation dialog, replacing `window.confirm`.
 *
 * ## Why a promise, not a `<Dialog open={…}>` per call site
 *
 * `window.confirm` is *synchronously blocking*, so every call site is written as a guard clause:
 *
 *     if (!window.confirm("Delete this?")) return;
 *     await api.delete(id);
 *
 * Expressing that with declarative dialog state means splitting each handler in two (open the
 * dialog; continue in its onConfirm) and hoisting whatever it was working on into component state —
 * across a dozen sites, with `pendingId` variables multiplying. Handing back a promise keeps the
 * original control flow intact:
 *
 *     if (!(await confirm({ title: "Delete this?" }))) return;
 *     await api.delete(id);
 *
 * One line changed per site, no restructuring, and the "did the user agree" logic stays exactly
 * where the reader expects it.
 *
 * ## Why it's better than the native dialog beyond looks
 *
 * `window.confirm` can't be styled or themed, is suppressible by the browser ("prevent this page
 * from creating additional dialogs" silently makes every future confirm return false — a
 * destructive action then looks like it did nothing), can't render emphasis or a resource name
 * safely, and freezes the whole tab. It also can't distinguish a destructive action from a benign
 * one, so "Delete everything" and "Refresh?" get identical affordances.
 *
 * ## Accessibility
 *
 * `role="alertdialog"` (not `dialog`) is the correct role for a message that requires a response,
 * and it keeps this off `getByRole("dialog")`, which existing tests use for content modals. Escape
 * and backdrop clicks cancel, focus is trapped while open and restored to the invoking element on
 * close, and the title/body are wired via aria-labelledby/aria-describedby.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "./forms";
import { Icon } from "./Icon";

export interface ConfirmOptions {
  /** The question. Short and specific — "Delete this webhook?" beats "Are you sure?". */
  title: string;
  /** What the reader needs to know before deciding — above all, what becomes irreversible. */
  body?: ReactNode;
  /** Label for the accept button. Name the ACTION ("Delete webhook"), never "OK": a button that
   *  says what it does survives being read on its own, which is how people actually read dialogs. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive/irreversible → red accept button, warning icon, and focus starts on Cancel. */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * The confirm function. Throws when no provider is mounted rather than silently resolving — a
 * missing provider would otherwise turn every guarded destructive action into a no-op (or, worse,
 * into an unguarded one), which is precisely the failure that must not be quiet.
 */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) {
    throw new Error(
      "useConfirm requires <ConfirmProvider> above it in the tree",
    );
  }
  return fn;
}

interface Pending {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

/** Focusable elements inside the dialog, in tab order (for the focus trap). */
function focusables(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  // The pending resolver lives in a ref too, so unmount can settle it without a stale-state read.
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      // A second confirm while one is open would orphan the first promise forever (an awaiting
      // handler that never resumes). Decline the outstanding one instead — declining is the safe
      // resolution for a question nobody answered.
      pendingRef.current?.resolve(false);
      setPending({ opts, resolve });
    });
  }, []);

  // If the provider unmounts with a question open, settle it — an unresolved promise would leave
  // the caller's `await` hanging forever.
  useEffect(() => {
    return () => pendingRef.current?.resolve(false);
  }, []);

  const settle = useCallback((ok: boolean) => {
    setPending((p) => {
      p?.resolve(ok);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          key={pending.opts.title}
          opts={pending.opts}
          onSettle={settle}
        />
      )}
    </ConfirmContext.Provider>
  );
}

/** The rendered question. Split out so each new question remounts with fresh focus handling. */
function ConfirmDialog({
  opts,
  onSettle,
}: {
  opts: ConfirmOptions;
  onSettle: (ok: boolean) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const danger = opts.danger ?? false;

  /**
   * Focus management: remember what had focus, move into the dialog, restore on close. Without the
   * restore, dismissing a confirm dumps keyboard users back at the top of the document.
   *
   * The initial target is found by querying the panel rather than by a ref on `Button` (the shared
   * component doesn't forward one) or `autoFocus` (which competes with any other autofocus on the
   * page and gets dropped with "Autofocus processing was blocked").
   */
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current
      ?.querySelector<HTMLElement>(
        danger
          ? '[data-testid="confirm-cancel"]'
          : '[data-testid="confirm-accept"]',
      )
      ?.focus();
    return () => previous?.focus?.();
  }, [danger]);

  // Escape cancels; Tab is trapped inside the panel so focus can't wander to the page behind a
  // modal that is meant to be blocking.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onSettle(false);
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = focusables(panel.current);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // Wrap at both ends, and pull focus back in if it has already escaped the panel.
      if (e.shiftKey && (active === first || !panel.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey &&
        (active === last || !panel.current.contains(active))
      ) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onSettle]);

  const titleId = "confirm-title";
  const bodyId = "confirm-body";

  return (
    <div
      className="overlay"
      // Backdrop click cancels — same affordance as Escape, and matches every other overlay here.
      onClick={() => onSettle(false)}
      data-testid="confirm-dialog"
    >
      <div
        ref={panel}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={opts.body ? bodyId : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", gap: 14, padding: "20px 20px 4px" }}>
          {danger && (
            <span
              aria-hidden="true"
              style={{
                flex: "none",
                width: 32,
                height: 32,
                borderRadius: 8,
                display: "grid",
                placeItems: "center",
                background: "var(--error-soft)",
                color: "var(--state-error)",
              }}
            >
              <Icon name="alert" size={16} />
            </span>
          )}
          <div style={{ minWidth: 0 }}>
            <div
              id={titleId}
              style={{
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-semibold)",
                lineHeight: 1.35,
              }}
            >
              {opts.title}
            </div>
            {opts.body && (
              <div
                id={bodyId}
                style={{
                  marginTop: 8,
                  fontSize: "var(--text-sm)",
                  color: "var(--ink-2)",
                  lineHeight: 1.55,
                  overflowWrap: "anywhere",
                }}
              >
                {opts.body}
              </div>
            )}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 9,
            padding: "18px 20px 20px",
          }}
        >
          {/* For a destructive action the SAFE choice is focused first, so a reflexive Enter or
              Space cancels rather than deletes. Non-destructive confirms focus the accept button,
              where fast-pathing the common case costs nothing. */}
          <Button
            variant="secondary"
            onClick={() => onSettle(false)}
            data-testid="confirm-cancel"
          >
            {opts.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={() => onSettle(true)}
            data-testid="confirm-accept"
          >
            {opts.confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
}
