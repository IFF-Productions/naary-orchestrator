import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { NodeCatalog } from "./NodeCatalog";

/**
 * The catalog is fully client-side (derived from the @naary/dsl registry) — no
 * MSW handlers needed. The global decorators supply MemoryRouter + theme; the
 * per-story decorator below seeds the localStorage recents the screen persists.
 */
const withRecents: Decorator = (Story, ctx) => {
  const recents = ctx.parameters.recents as string[] | undefined;
  if (recents) {
    localStorage.setItem("naary.catalog.recents", JSON.stringify(recents));
  } else {
    localStorage.removeItem("naary.catalog.recents");
  }
  return <Story />;
};

const meta: Meta<typeof NodeCatalog> = {
  title: "Screens/Node catalog",
  component: NodeCatalog,
  decorators: [withRecents],
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof NodeCatalog>;

/** Default view — category rail with counts, recents chip row, full grid. */
export const Default: Story = {
  parameters: {
    // Real entry ids (node types / integration:<provider>) — the design's mock
    // shows webhook / LLM agent / if / http as recently used.
    recents: ["webhookTrigger", "agent", "if", "httpRequest"],
  },
};

/** A search in progress — result count label + clear button. */
export const SearchResults: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByLabelText("Search nodes");
    await userEvent.type(input, "sql");
    await waitFor(() => expect(canvas.getByText(/results? for/)).toBeTruthy());
    await canvas.findByText("SQL Query");
  },
};

/** The empty-search state with its teaching copy. */
export const EmptySearch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = await canvas.findByLabelText("Search nodes");
    await userEvent.type(input, "zzzz-no-such-node");
    await canvas.findByText(/No nodes match/);
  },
};

/** Clicking a card opens the detail drawer (inputs / outputs / auth derived
 *  from the registry, "Add to canvas" CTA). */
export const DrawerOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByRole("button", { name: "HTTP Request" });
    await userEvent.click(card);
    const drawer = await canvas.findByRole("complementary", {
      name: /HTTP Request details/,
    });
    await waitFor(() =>
      expect(
        within(drawer).getByRole("button", { name: /Add to canvas/ }),
      ).toBeTruthy(),
    );
    // Registry-derived detail rows: url is a required input, status an output.
    await within(drawer).findByText("url");
    await within(drawer).findByText("status");
  },
};
