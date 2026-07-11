import "./instrument"; // MUST be first — Sentry init before any app code runs.
import { reactErrorHandler } from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./styles/global.css";
import { AuthProvider } from "./auth/AuthProvider";
import { ModeProvider, ModeSync } from "./mode";
import { router } from "./router";
import { ThemeProvider } from "./theme";

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
          <RouterProvider router={router} />
        </AuthProvider>
      </ModeProvider>
    </ThemeProvider>
  </StrictMode>,
);
