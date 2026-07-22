// Bottom-right canvas toasts (extracted verbatim from CanvasPage): a self-contained
// queue with auto-dismiss timers cleaned up on unmount. Leaf hook — no external deps.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasToast } from "./canvas-types";

export function useCanvasToasts() {
  const [toasts, setToasts] = useState<CanvasToast[]>([]);
  const toastSeq = useRef(0);
  const toastTimers = useRef<number[]>([]);
  useEffect(() => {
    const pending = toastTimers.current;
    return () => pending.forEach(clearTimeout);
  }, []);
  const pushToast = useCallback(
    (text: string, meta?: string, tone: "ok" | "warn" = "ok") => {
      const id = ++toastSeq.current;
      setToasts((t) => [...t, { id, text, meta, tone }]);
      toastTimers.current.push(
        window.setTimeout(
          () => setToasts((t) => t.filter((x) => x.id !== id)),
          2600,
        ),
      );
    },
    [],
  );
  return { toasts, pushToast };
}
