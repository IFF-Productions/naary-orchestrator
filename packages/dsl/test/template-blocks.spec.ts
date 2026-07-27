import { describe, expect, it } from "vitest";
import { renderEmailHtml, type TemplateBlock } from "../src/template-blocks";

const ctx = {
  trigger: { name: "Ada", url: "https://acme.co/orders/42" },
  agent: { text: "Your order shipped." },
  hook: {
    xss: `<script>alert(1)</script>`,
    attr: `"><img src=x onerror=alert(1)>`,
  },
};

describe("renderEmailHtml", () => {
  it("interpolates {{ }} in headings/text/buttons and skips form fields", () => {
    const blocks: TemplateBlock[] = [
      { id: "1", type: "heading", level: 1, text: "Hi {{ trigger.name }}" },
      { id: "2", type: "text", html: "<p>{{ agent.text }}</p>" },
      { id: "3", type: "button", label: "Track", href: "{{ trigger.url }}" },
      { id: "4", type: "divider" },
      {
        id: "5",
        type: "field",
        key: "email",
        label: "Email",
        fieldType: "email",
        required: true,
      },
    ];
    const html = renderEmailHtml(blocks, ctx);
    expect(html).toContain("<h1>Hi Ada</h1>");
    expect(html).toContain("<p>Your order shipped.</p>");
    expect(html).toContain('<a href="https://acme.co/orders/42">Track</a>');
    expect(html).toContain("<hr />");
    // the FORM field block is skipped when rendering an email
    expect(html).not.toContain("email");
  });

  it("HTML-ESCAPES interpolated ctx values — script/attr payloads never become live markup", () => {
    const blocks: TemplateBlock[] = [
      { id: "1", type: "text", html: "<p>{{ hook.xss }}</p>" },
      { id: "2", type: "heading", level: 2, text: "{{ hook.attr }}" },
    ];
    const html = renderEmailHtml(blocks, ctx);
    // the script tag is escaped, not emitted live
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    // the attribute-breakout payload is neutralised (no live <img ... onerror>)
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).toContain("&quot;&gt;&lt;img");
    // the author's own <p> markup in the text block is preserved (only the VALUE is escaped)
    expect(html).toContain("<p>");
  });

  it("rejects dangerous URL schemes in href/src (javascript:/data:/vbscript:)", () => {
    const blocks: TemplateBlock[] = [
      { id: "1", type: "button", label: "x", href: "javascript:alert(1)" },
      { id: "2", type: "button", label: "y", href: "{{ evil }}" },
      {
        id: "3",
        type: "image",
        src: "data:text/html,<script>alert(1)</script>",
      },
    ];
    const html = renderEmailHtml(blocks, {
      evil: "vbscript:msgbox(1)",
    } as Record<string, unknown>);
    // rejected hrefs → no anchor (rendered as a plain span), rejected img src → dropped
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("vbscript:");
    expect(html).not.toContain("<img");
    expect(html).toContain("<span>x</span>");
  });

  it("rejects control/whitespace scheme obfuscation the browser would normalize (#587 review)", () => {
    // Browsers strip tab/newline/leading-control from a URL before parsing the scheme, so these
    // resolve to `javascript:` in the client even though the literal string isn't. The renderer
    // must normalize the SAME way and reject them (a plain string match on "javascript:" would miss).
    const payloads = [
      "java\nscript:alert(1)",
      "java\tscript:alert(1)",
      "\x01javascript:alert(1)",
      "  javascript:alert(1)",
      "JavaScript:alert(1)",
    ];
    for (const href of payloads) {
      const html = renderEmailHtml(
        [{ id: "1", type: "button", label: "go", href }],
        {},
      );
      // No anchor emitted (rendered as a plain span), and no live javascript: URL survives.
      expect(html.toLowerCase()).not.toContain("javascript:");
      expect(html).not.toContain("<a ");
      expect(html).toContain("<span>go</span>");
    }
  });

  it("never throws on a circular ctx object — renders a safe marker (#587 review)", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular; // JSON.stringify would throw
    // Must not throw — email rendering has to be total.
    const html = renderEmailHtml(
      [{ id: "1", type: "text", html: "<p>{{ node }}</p>" }],
      { node: circular },
    );
    expect(html).toContain("[unserializable]");
  });

  it("preserves {{ $secrets.NAME }} verbatim for in-activity resolution (never rendered here)", () => {
    const html = renderEmailHtml(
      [{ id: "1", type: "text", html: "key: {{ $secrets.API_KEY }}" }],
      {},
    );
    expect(html).toContain("{{ $secrets.API_KEY }}");
  });
});
