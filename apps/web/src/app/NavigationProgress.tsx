/**
 * Top progress bar for in-shell navigation (redesign shell) — a 2px ember bar across the
 * top of the content region while the data router is loading a lazy screen; completes and
 * fades on idle. Purely presentational; driven by react-router's navigation state.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router-dom";

export function NavigationProgress() {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (busy) {
      setVisible(true);
      setWidth(18); // jump-start, then creep toward 80%
      timer.current = setTimeout(() => setWidth(80), 120);
    } else if (visible) {
      setWidth(100);
      timer.current = setTimeout(() => {
        setVisible(false);
        setWidth(0);
      }, 260);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // `visible` is deliberately not a dep — it would re-trigger the fade-out cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  if (!visible) return null;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 12,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${width}%`,
          background: "var(--brand-gradient)",
          boxShadow: "0 0 8px rgba(242, 98, 46, 0.7)",
          transition: busy
            ? "width 4s cubic-bezier(.1,.6,.3,1)"
            : "width .18s ease, opacity .24s ease",
          opacity: busy ? 1 : width === 100 ? 0.9 : 1,
        }}
      />
    </div>
  );
}
