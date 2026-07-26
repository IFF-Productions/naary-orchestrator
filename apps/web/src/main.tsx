import "./instrument"; // MUST be first — Sentry init before any app code runs.
import { reactErrorHandler } from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./styles/global.css";
import { AuthProvider } from "./auth/AuthProvider";
import { ConfirmProvider } from "./components";
import { reloadForFreshChunks } from "./lib/chunk-reload";
import { ModeProvider, ModeSync } from "./mode";
import { router } from "./router";
import { ThemeProvider } from "./theme";

// A new deploy replaced the hashed assets this (cached) client points at, so a lazy chunk's JS/CSS
// preload 404s. Vite fires `vite:preloadError` — reload to fetch the fresh index.html + chunk names
// (guarded against loops). We do NOT preventDefault: that would make Vite CONTINUE past the failed
// preload (the import then resolves undefined → a confusing downstream TypeError). Letting it reject
// means that if the reload is guarded off, the real chunk error reaches the router errorElement.
window.addEventListener("vite:preloadError", () => {
  reloadForFreshChunks();
});

// React 19: route uncaught/caught/recoverable render errors to Sentry (no-op if disabled).
createRoot(document.getElementById("root")!, {
  onUncaughtError: reactErrorHandler(),
  onCaughtError: reactErrorHandler(),
  onRecoverableError: reactErrorHandler(),
}).render(
  <StrictMode>
    <ThemeProvider>
      <ModeProvider>
        <AuthProvider>
          {/* Reconciles the cross-device mode preference once authenticated; renders nothing. */}
          <ModeSync />
          {/* Hosts the one in-app confirm dialog (replacing window.confirm). Inside the theme
              providers so it picks up the active theme, and above the router so every screen —
              including the public pages — can call useConfirm(). */}
          <ConfirmProvider>
            <RouterProvider router={router} />
          </ConfirmProvider>
        </AuthProvider>
      </ModeProvider>
    </ThemeProvider>
  </StrictMode>,
);
