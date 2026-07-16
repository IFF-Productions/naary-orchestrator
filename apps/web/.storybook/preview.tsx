import type { Decorator, Preview } from "@storybook/react-vite";
import { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import { initialize, mswLoader } from "msw-storybook-addon";
// The real design tokens (--ink / --brand / --surface …) + resets the app renders with. Without
// this the components paint against undefined CSS variables, which defeats the visualization.
import "../src/styles/global.css";
import "../src/components/components.css";

// Start MSW so stories can mock `/api` (see parameters.msw.handlers). onUnhandledRequest: bypass
// so static assets / unmocked calls don't spam warnings; a story without handlers just no-ops.
initialize({ onUnhandledRequest: "bypass" });

// Router context for components that use react-router (useNavigate/useLocation) — harmless for
// the rest. Stories that need a specific path can override with their own router.
const withRouter: Decorator = (Story) => (
  <MemoryRouter>
    <Story />
  </MemoryRouter>
);

// The app is dark-first; light theme via [data-theme="light"] (styles/tokens.css). Mirror that
// here with a toolbar switch so stories can be inspected in both themes.
const withTheme: Decorator = (Story, ctx) => {
  const theme = ctx.globals.theme ?? "dark";
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "light") el.setAttribute("data-theme", "light");
    else el.removeAttribute("data-theme");
    document.body.style.background = "var(--bg, var(--surface))";
    document.body.style.color = "var(--ink)";
  }, [theme]);
  return <Story />;
};

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
  decorators: [withTheme, withRouter],
  loaders: [mswLoader],
};

export default preview;
