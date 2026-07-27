import type { Decorator, Preview } from "@storybook/react-vite";
import { ConfirmProvider } from "../src/components";
import { WorkspaceProvider } from "../src/workspace/WorkspaceProvider";
import { type ReactNode, useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { setupWorker } from "msw/browser";
import { mswLoader } from "msw-storybook-addon/csf3";
// The real design tokens (--ink / --brand / --surface …) + resets the app renders with. Without
// this the components paint against undefined CSS variables, which defeats the visualization.
import "../src/styles/global.css";
import "../src/components/components.css";

// Start MSW so stories can mock `/api` (see parameters.msw.handlers). onUnhandledRequest: bypass
// so static assets / unmocked calls don't spam warnings; a story without handlers just no-ops.
// msw-storybook-addon v3 removed the top-level `initialize()`; the worker options fold into
// `mswLoader`'s setup fn (a factory now). mswLoader memoizes this so the worker starts once.
// See MIGRATION.md (2.x → 3.x) — this is the codemod's canonical CSF-3 output.
/**
 * Default handlers so a story that declares none stays OFFLINE and deterministic.
 *
 * `WorkspaceProvider` (added as a global decorator below) fetches `/api/me/workspaces` on mount,
 * which without this would fire a real request from EVERY story — including pure component ones
 * like `confirm.stories.tsx` that have no business talking to an API. A story's own
 * `parameters.msw.handlers` still override these.
 */
const defaultHandlers = [
  http.get("/api/me/workspaces", () =>
    HttpResponse.json([{ id: "t-demo", displayName: "Acme", role: "owner" }]),
  ),
];

const mswSetup = async () => {
  const worker = setupWorker(...defaultHandlers);
  await worker.start({ onUnhandledRequest: "bypass" });
  return worker;
};

// Router context for components that use react-router (useNavigate/useLocation/useParams).
// One MemoryRouter for the whole app — nesting a second one errors in RR v7, so stories that need
// route params declare them via `parameters.router` instead of adding their own router:
//   parameters: { router: { path: "/app/runs/:id", initialEntries: ["/app/runs/wh-1"] } }
// Default is a catch-all route, harmless for components that don't read params.
const withRouter: Decorator = (Story, ctx) => {
  const r = (ctx.parameters.router ?? {}) as {
    path?: string;
    initialEntries?: string[];
  };
  return (
    <MemoryRouter initialEntries={r.initialEntries ?? ["/"]}>
      <Routes>
        <Route path={r.path ?? "*"} element={<Story />} />
      </Routes>
    </MemoryRouter>
  );
};

// The app is dark-first; light theme via [data-theme="light"] (styles/tokens.css). Mirror that
// here with a toolbar switch so stories can be inspected in both themes.
// A real component (not the decorator fn) owns the hook, so react-hooks/rules-of-hooks is satisfied
// — a lower-cased decorator calling useEffect isn't recognized as a component/custom hook.
function ThemeStage({
  theme,
  children,
}: {
  theme: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "light") el.setAttribute("data-theme", "light");
    else el.removeAttribute("data-theme");
    document.body.style.background = "var(--bg, var(--surface))";
    document.body.style.color = "var(--ink)";
  }, [theme]);
  return <>{children}</>;
}

/**
 * App-level React contexts every screen assumes, supplied globally because a screen that calls
 * `useConfirm` or `useWorkspace` THROWS without them — Storybook catches it and renders its error
 * panel, so the story silently shows nothing.
 *
 * Measured before adding these: **23 of 210 stories** rendered no UI at all (22 × `useConfirm
 * requires <ConfirmProvider>`, 1 × `useWorkspace must be used within <WorkspaceProvider>`),
 * including Groups, Integrations, RunDetail, Workflow detail and the full app Shell. A story that
 * renders an error panel is worse than a missing one: it still appears in the catalog, and any
 * visual guard built on it (the #708 scroller probe, screenshot review) measures the error panel
 * instead of the screen — which is exactly how a 71%-hidden reading came out of a table that
 * wasn't even on screen.
 */
const withProviders: Decorator = (Story) => (
  <WorkspaceProvider>
    <ConfirmProvider>
      <Story />
    </ConfirmProvider>
  </WorkspaceProvider>
);

const withTheme: Decorator = (Story, ctx) => (
  <ThemeStage theme={(ctx.globals.theme as string) ?? "dark"}>
    <Story />
  </ThemeStage>
);

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
  globalTypes: {
    theme: {
      description: "Design-system theme",
      defaultValue: "dark",
      toolbar: {
        title: "Theme",
        icon: "circlehollow",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
        ],
        dynamicTitle: true,
      },
    },
  },
  // Providers are innermost: inside the theme so anything they render paints against real tokens,
  // and inside the router so a story's own `parameters.router` still applies. (Neither provider
  // needs the router itself — an earlier version of this comment claimed WorkspaceProvider
  // navigates, and it does not.)
  decorators: [withTheme, withRouter, withProviders],
  loaders: [mswLoader(mswSetup)],
};

export default preview;
