import { describe, expect, it } from "vitest";
import {
  MANUAL_OPTION,
  workflowSelectChoice,
  workflowSelectView,
} from "../src/screens/canvas/workflow-select-model";

/**
 * The sub-workflow picker replaced a free-text `workflowKey`. The risk in that trade is a
 * <select> quietly rewriting a key it doesn't recognise — which happens routinely (another
 * environment, a deleted workflow, one referenced before it was saved).
 */
const LIST = [
  { workflowKey: "process-one-item" },
  { workflowKey: "notify-oncall" },
];

describe("workflowSelectView", () => {
  it("flags a key the list doesn't contain, so the control can still show it", () => {
    // Without an option carrying this value the browser renders the FIRST option instead, and a
    // node that targets `archived-flow` reads as targeting nothing.
    expect(workflowSelectView("archived-flow", LIST).unknownValue).toBe(true);
  });

  it("does not flag a key that IS in the list", () => {
    expect(workflowSelectView("notify-oncall", LIST).unknownValue).toBe(false);
  });

  it("does not flag an unset key — empty is not 'unknown'", () => {
    // An empty select is the honest rendering of "no sub-workflow chosen"; warning about it
    // would put a scary line under every freshly-dropped node.
    expect(workflowSelectView("", LIST).unknownValue).toBe(false);
    expect(workflowSelectView("", []).unknownValue).toBe(false);
  });

  it("says why the list is empty rather than showing a blank chooser", () => {
    expect(workflowSelectView("", []).placeholder).toBe(
      "No other workflows saved yet",
    );
    expect(workflowSelectView("", LIST).placeholder).toBe("Select a workflow…");
  });
});

describe("workflowSelectChoice", () => {
  it("never returns the manual sentinel as a key", () => {
    // `__manual__` written into the graph would be a permanently unresolvable sub-workflow
    // target that saves cleanly and fails at run time.
    expect(workflowSelectChoice(MANUAL_OPTION)).toEqual({ manual: true });
  });

  it("passes a real key through", () => {
    expect(workflowSelectChoice("notify-oncall")).toEqual({
      key: "notify-oncall",
    });
  });

  it("passes the empty choice through as a key, so a node can be un-targeted", () => {
    expect(workflowSelectChoice("")).toEqual({ key: "" });
  });
});
