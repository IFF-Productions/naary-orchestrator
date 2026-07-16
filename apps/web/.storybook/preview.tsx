import type { Decorator, Preview } from "@storybook/react-vite";
import { useEffect } from "react";
// The real design tokens (--ink / --brand / --surface …) + resets the app renders with. Without
// this the components paint against undefined CSS variables, which defeats the visualization.
import "../src/styles/global.css";
import "../src/components/components.css";

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
  decorators: [withTheme],
};

export default preview;
