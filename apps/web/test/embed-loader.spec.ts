// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Execute the static public/embed.js loader in a jsdom document and assert it (a) injects the
// chrome-less iframes and (b) resizes them only on same-origin height messages.
// (jsdom makes import.meta.url an http URL, so resolve from cwd = repo root instead.)
const code = readFileSync(
  resolve(process.cwd(), "apps/web/public/embed.js"),
  "utf8",
);
const ORIGIN = "https://app.test";

function runLoader() {
  // The loader derives our origin from its own <script src>; stub currentScript.
  Object.defineProperty(document, "currentScript", {
    value: { src: `${ORIGIN}/embed.js` },
    configurable: true,
  });
  // new Function → runs the IIFE against jsdom's global window/document.
  new Function(code)();
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("embed.js loader", () => {
  it("injects a chrome-less iframe for data-naary-form and data-naary-chat", () => {
    document.body.innerHTML =
      '<div data-naary-form="F1"></div><div data-naary-chat="C1"></div>';
    runLoader();

    const form = document.querySelector<HTMLIFrameElement>(
      'iframe[data-naary-id="F1"]',
    );
    const chat = document.querySelector<HTMLIFrameElement>(
      'iframe[data-naary-id="C1"]',
    );
    expect(form?.src).toBe(`${ORIGIN}/f/F1?embed=1`);
    expect(chat?.src).toBe(`${ORIGIN}/c/C1?embed=1`);
    // Marked mounted so a re-scan doesn't double-inject.
    expect(
      document
        .querySelector("[data-naary-form]")
        ?.getAttribute("data-naary-mounted"),
    ).toBe("1");
  });

  it("resizes the matching iframe ONLY on a same-origin naary:resize message", () => {
    document.body.innerHTML = '<div data-naary-form="F1"></div>';
    runLoader();
    const frame = document.querySelector<HTMLIFrameElement>(
      'iframe[data-naary-id="F1"]',
    );

    // Wrong origin → ignored.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://evil.test",
        data: { type: "naary:resize", id: "F1", height: 999 },
      }),
    );
    expect(frame?.style.height).not.toBe("999px");

    // Our origin → resized.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: ORIGIN,
        data: { type: "naary:resize", id: "F1", height: 812 },
      }),
    );
    expect(frame?.style.height).toBe("812px");

    // A different id doesn't touch this frame.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: ORIGIN,
        data: { type: "naary:resize", id: "OTHER", height: 100 },
      }),
    );
    expect(frame?.style.height).toBe("812px");
  });
});
