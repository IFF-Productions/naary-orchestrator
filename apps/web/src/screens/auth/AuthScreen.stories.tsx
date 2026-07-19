import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { AuthScreen } from "./AuthScreen";

/**
 * The screen takes its auth calls as props (AuthPage wires the real Firebase
 * ones), so stories stand in timed fakes: resolve ⇒ the simulation lands on
 * done; reject ⇒ the honest failed state. No Firebase in Storybook.
 */
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const meta: Meta<typeof AuthScreen> = {
  title: "Screens/Auth",
  component: AuthScreen,
  parameters: { layout: "fullscreen" },
  args: {
    configured: true,
    login: () => delay(2600),
    loginEmail: () => delay(4200),
    signupEmail: () => delay(4200),
    resetPassword: () => delay(300),
    onAuthed: () => {},
    onApiToken: () => {},
  },
};
export default meta;
type Story = StoryObj<typeof AuthScreen>;

/** Sign-in: canvas idle — trigger done, the rest awaiting identity. */
export const Login: Story = {};

/** Sign-up: Full name field + the provisioning node-label variants. */
export const Signup: Story = { args: { initialMode: "signup" } };

/** Typing a valid email/password drives nodes 2–3 to done; submit starts the
 *  staged run (verify → paused approval gate → provision) and lands on done
 *  when the mocked auth promise resolves (~4.2s). */
export const SimulationRunning: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByPlaceholderText("you@company.io"),
      "maria@acme.io",
    );
    await userEvent.type(
      canvas.getByPlaceholderText("At least 6 characters"),
      "hunter22",
    );
    await waitFor(() => expect(canvas.getByText(/Ready to run/)).toBeTruthy());
    await userEvent.click(canvas.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(canvas.getByText("Running workflow…")).toBeTruthy(),
    );
    // The paused human gate (amber ping) at +1s.
    await waitFor(
      () =>
        expect(
          canvas.getByText("Paused — auto-approving human gate…"),
        ).toBeTruthy(),
      { timeout: 3000 },
    );
  },
};

/** The real promise rejects → the run stops honestly: red-tinted status bar +
 *  the actual auth error in the form. Never a faked success. */
export const AuthFailure: Story = {
  args: {
    loginEmail: async () => {
      await delay(1400);
      throw new Error("Invalid email or password.");
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByPlaceholderText("you@company.io"),
      "maria@acme.io",
    );
    await userEvent.type(
      canvas.getByPlaceholderText("At least 6 characters"),
      "wrong-pass",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(canvas.getByText(/Run failed/)).toBeTruthy(), {
      timeout: 6000,
    });
    await waitFor(() =>
      expect(canvas.getByText("Invalid email or password.")).toBeTruthy(),
    );
  },
};

/** No Firebase config: Google disabled with the fallback note, API-token
 *  field open by default (the only way in). */
export const NotConfigured: Story = { args: { configured: false } };
