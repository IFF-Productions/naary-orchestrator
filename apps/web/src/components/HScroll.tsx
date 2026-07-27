/**
 * A horizontal scroller that SAYS it scrolls (#708).
 *
 * Some tables can't become cards on a phone — a permission matrix is a grid by nature, and its
 * checkboxes sit ~37px apart centre-to-centre, so it can't take a blanket touch-target bump
 * either. For those, horizontal scroll is the right answer; the defect is that nothing indicates
 * it. At 390px the grant matrices hide 260–300px, roughly half of every row, behind a scroller
 * that looks exactly like the end of the table.
 *
 * Edge fades appear ONLY on the side that actually has more content, so they never imply columns
 * that aren't there — and both disappear entirely when everything fits, which is the common case
 * on a desktop.
 *
 * Extracted when the second grant matrix turned up (Groups and CompanyGroups have separate
 * implementations of the same grid); one copy of the measuring logic, two callers.
 */
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export function HScroll({
  children,
  style,
  scrollerStyle,
  /** Re-measure when this changes — content can widen without any box resizing. */
  deps,
}: {
  children: ReactNode;
  style?: CSSProperties;
  scrollerStyle?: CSSProperties;
  deps?: unknown;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({
      left: el.scrollLeft > 1,
      // 1px slack: sub-pixel layout can leave scrollLeft a hair short of max at the end.
      right: max > 1 && el.scrollLeft < max - 1,
    });
  }, []);

  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The CONTENT too, not just the viewport: a new row can widen the content without the
    // scroller's own box changing size, which an observer on the scroller alone would miss.
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure, deps]);

  return (
    <div style={{ position: "relative", ...style }}>
      {(["left", "right"] as const).map((side) =>
        edges[side] ? (
          <div
            key={side}
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              [side]: 0,
              width: 26,
              pointerEvents: "none",
              zIndex: 1,
              background: `linear-gradient(to ${
                side === "left" ? "right" : "left"
              }, var(--panel), transparent)`,
            }}
          />
        ) : null,
      )}
      <div
        ref={scroller}
        onScroll={measure}
        style={{ overflowX: "auto", ...scrollerStyle }}
      >
        {children}
      </div>
    </div>
  );
}
