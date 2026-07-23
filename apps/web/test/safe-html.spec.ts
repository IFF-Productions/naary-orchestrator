// @vitest-environment jsdom
// DOMPurify needs a real DOM, so this one spec runs under jsdom (the suite is node-env by default).
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../src/components/SafeHtml";

/**
 * Guards the stored-XSS fix: a `text` block's author HTML is rendered via dangerouslySetInnerHTML in
 * the (shared, env-scoped) template editor. `sanitizeHtml` must neutralize the vectors that actually
 * execute when HTML is assigned to innerHTML — event-handler attributes and dangerous URL schemes.
 * (A raw <script> tag does NOT run via innerHTML, so those vectors, not <script>, are the real test.)
 */
describe("sanitizeHtml", () => {
  it("strips the onerror handler off an <img> (the classic innerHTML XSS)", () => {
    const clean = sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(clean).not.toMatch(/onerror/i);
    expect(clean).not.toMatch(/alert/);
  });

  it("strips <svg onload=…>", () => {
    const clean = sanitizeHtml('<svg onload="alert(1)"></svg>');
    expect(clean).not.toMatch(/onload/i);
    expect(clean).not.toMatch(/alert/);
  });

  it("drops a javascript: href", () => {
    const clean = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(clean).not.toMatch(/javascript:/i);
  });

  it("removes a <script> element entirely", () => {
    const clean = sanitizeHtml("<p>hi</p><script>alert(1)</script>");
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/alert/);
  });

  it("neutralizes an entity/whitespace-obfuscated javascript: scheme", () => {
    // DOMPurify decodes entities and re-parses, catching `j&#x61;vascript:` style bypasses that a
    // naive regex sanitizer would miss.
    const clean = sanitizeHtml('<a href="j&#x61;vascript:alert(1)">x</a>');
    expect(clean.toLowerCase()).not.toContain("javascript:");
  });

  it("preserves safe formatting markup (so real templates still render)", () => {
    const clean = sanitizeHtml(
      '<p>Hi <strong>Sam</strong> — <a href="https://x.com">link</a></p>',
    );
    expect(clean).toMatch(/<strong>Sam<\/strong>/);
    expect(clean).toMatch(/<a[^>]*href="https:\/\/x\.com"/);
    expect(clean).toMatch(/Hi /);
  });
});
