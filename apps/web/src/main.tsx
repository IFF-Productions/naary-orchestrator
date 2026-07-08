import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./styles/global.css";
import { AuthProvider } from "./auth/AuthProvider";
import { ModeProvider, ModeSync } from "./mode";
import { router } from "./router";
import { ThemeProvider } from "./theme";

createRoot(document.getElementById("root")!).render(
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
