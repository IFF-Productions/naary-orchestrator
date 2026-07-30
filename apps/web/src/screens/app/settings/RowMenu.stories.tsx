import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, waitFor, within } from "storybook/test";
import { LockGlyph, panelStyle, RowMenu } from "./shared";

// RowMenu renders its dropdown in a portal so the settings panel's `overflow: hidden` (rounded
// corners) can't clip it — the bug where "Update value…" was cut off inside the row. This story
// reproduces the exact context: the menu sits on the LAST row of an `overflow: hidden` panel, so an
// in-flow menu WOULD be clipped; the portal one overlays past the panel edge. Open the ⋮ to see it.
const meta: Meta<typeof RowMenu> = { title: "Settings/RowMenu" };
export default meta;
type Story = StoryObj<typeof RowMenu>;

function SecretRow({ name, env }: { name: string; env: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        // Height is PINNED rather than derived from the type, so the row count below lands the last
        // kebab at a known y — a repro whose geometry drifts with a font metric is not a repro.
        height: 48,
        boxSizing: "border-box",
        padding: "13px 18px",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <LockGlyph style={{ color: "var(--ink-faint)" }} />
      {/* `minWidth: 0` + ellipsis so the NAME absorbs a narrow viewport. Without it the row's
          fixed-width tail pushed the kebab itself 1–31px past the right edge at 390, adding
          overflow noise of the story's own making to every sweep that reads this file. */}
      <div
        className="mono"
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 12.5,
          fontWeight: 600,
        }}
      >
        {name}
      </div>
      <span
        style={{
          flex: "none",
          fontSize: 11,
          color: "var(--brand)",
          border: "1px solid var(--brand)",
          borderRadius: 12,
          padding: "1px 8px",
        }}
      >
        {env}
      </span>
      <span
        className="mono"
        style={{ flex: "none", fontSize: 11.5, color: "var(--ink-faint)" }}
      >
        ••••••••
      </span>
      <RowMenu
        label={`Actions for ${name}`}
        items={[
          { label: "Update value…", onClick: () => {} },
          { label: "Delete", danger: true, onClick: () => {} },
        ]}
      />
    </div>
  );
}

/** The panel uses `overflow: hidden` (rounded corners). The menu on the LAST row must still overlay
 *  past the panel's bottom edge — proof the portal escapes the clip. Click the ⋮ on the last row. */
export const InsidePanel: Story = {
  render: () => (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <div style={panelStyle}>
        <SecretRow name="GITHUB_TOKEN" env="Production" />
        <SecretRow name="STRIPE_KEY" env="Production" />
      </div>
    </div>
  ),
};

/** 16 rows of 48px + 24px of padding puts the last kebab at y≈797 in an 844px-tall phone. */
const MANY = [
  "AIRTABLE_PAT",
  "ANTHROPIC_KEY",
  "AWS_SECRET",
  "DATADOG_KEY",
  "DB_URL_ANALYTICS",
  "GITHUB_TOKEN",
  "JIRA_TOKEN",
  "LINEAR_KEY",
  "OPENAI_KEY",
  "PAGERDUTY_KEY",
  "SENDGRID_KEY",
  "SENTRY_DSN",
  "SLACK_TOKEN",
  "STRIPE_KEY",
  "TWILIO_TOKEN",
  "ZENDESK_TOKEN",
];

/**
 * **The state no story opened, at the harness's own default viewport (390×844).**
 *
 * `InsidePanel` proves the portal escapes the panel's `overflow: hidden` — and stops there, with
 * the menu CLOSED ("Open the ⋮ to see it"), which is why every #511 sweep measured a 28px kebab
 * and nothing else. A settings list is as long as the workspace's secret count, so on a phone the
 * bottom rows' kebabs sit near the fold, and `RowMenu` placed its portal at `anchor.bottom + 4`
 * with no clamp: the menu opened past the bottom of the screen.
 *
 * That is worse than clipped. The menu is `position: fixed`, so page scroll cannot move it — and
 * `RowMenu` closes on *any* scroll (so a fixed menu can't drift off its row), which means the one
 * gesture that would bring the row up **destroys the menu instead**. Measured at 390×844:
 *
 * |  | before | after |
 * |---|---|---|
 * | menu box | top 811, bottom **885 / 844** | top 687, bottom **761 / 844** (flipped above) |
 * | `Update value…` | 4px below the fold | 0 |
 * | `Delete` | **36px** below the fold, wholly offscreen | 0 |
 *
 * The same defect on the real screen, `screens-settings--secrets` at 375×667 (an iPhone SE): the
 * sandbox `STRIPE_KEY` row's menu opened at top 671 / bottom 745 — **78px past the fold, entirely
 * off the screen** — and now opens at 545/619. The row's only actions, one of them destructive,
 * could not be reached by any gesture.
 *
 * The play function opens the LAST row's menu, so the committed sweep measures the open state.
 */
export const OpenNearTheBottom: Story = {
  render: () => (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <div style={panelStyle}>
        {MANY.map((name) => (
          <SecretRow key={name} name={name} env="Production" />
        ))}
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const kebabs = canvas.getAllByRole("button", { name: /^Actions for/ });
    // `fireEvent.click`, not `userEvent.click`: userEvent's full pointer sequence focuses the
    // button first, and focusing an element this close to the fold makes the browser scroll the
    // document a few px — which RowMenu's own `scroll` listener turns into a close. The menu opened
    // and shut inside the play function. A real trusted click (verified with Playwright) opens it
    // and it stays open, so the sequence is a userEvent artefact, not the defect under measurement.
    fireEvent.click(kebabs[kebabs.length - 1]);
    // The menu is portaled to <body>, outside canvasElement — query the document.
    await waitFor(() =>
      expect(
        document.body.querySelector<HTMLElement>(".menu-pop"),
      ).toBeTruthy(),
    );
  },
};
