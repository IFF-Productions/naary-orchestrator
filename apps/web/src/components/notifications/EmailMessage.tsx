/**
 * The three parts of a rendered notification email. Declared LOCALLY, exactly as
 * `SlackMessage` and `TeamsCard` declare their own block/card shapes, rather than importing
 * `NotificationEmail` from `@naary/notifications`.
 *
 * That is not a style choice. `apps/web/tsconfig.json` excludes `*.stories.tsx` precisely
 * because stories import that package and the web Docker image only prebuilds `@naary/dsl` —
 * so a non-story file under `src/` that imports it fails `tsc --noEmit` in the image with
 * TS2307, and takes the whole stack build with it. `import type` does not help: TS2307 is a
 * RESOLUTION failure, and a type-only import still needs the declarations.
 *
 * The stories pass real `notificationEmail()` output into this prop and ARE typechecked
 * against the real type (`tsconfig.storybook.json`, which maps `@naary/*` to source), so the
 * two shapes are still checked against each other — at the story boundary, like the siblings.
 */
type NotificationEmail = { subject: string; text: string; html: string };

/**
 * Preview of the email the worker/API actually sends, built by `@naary/notifications`
 * `notificationEmail`. Like `SlackMessage`/`TeamsCard` it exists so a formatting change is
 * reviewable without a live mailbox — but unlike those two it does NOT re-implement anything.
 *
 * The Slack and Teams previews have to interpret a JSON payload (Block Kit / Adaptive Card),
 * because the real renderer is Slack's or Teams'. An email's renderer is an HTML engine, and we
 * are already in one — so this injects `mail.html` verbatim. A JSX rebuild of the layout would be
 * a SECOND renderer of the thing under review, which is the exact bug #1059 is about.
 *
 * All three parts of a `NotificationEmail` are shown, because all three ship: the SUBJECT (the
 * only part a crowded inbox shows), the HTML body, and the PLAIN-TEXT body that plaintext
 * clients, "show original" views and digests render instead.
 */
export function EmailMessage({
  mail,
  from = "Naary <alerts@naary.io>",
  to = "ops@acme.example",
}: {
  mail: NotificationEmail;
  from?: string;
  to?: string;
}) {
  return (
    <div
      style={{
        maxWidth: 680,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#1f2328",
      }}
    >
      {/* Mail-client chrome. Deliberately plain: the artifact under review is what sits
          INSIDE it, and a convincing fake client would only compete with it. */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #d0d7de",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <div
          style={{ padding: "14px 18px", borderBottom: "1px solid #d0d7de" }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.35 }}>
            {mail.subject}
          </div>
          <div style={{ fontSize: 12, color: "#57606a", marginTop: 6 }}>
            {from} → {to}
          </div>
        </div>
        <div style={{ padding: 18, background: "#ffffff" }}>
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the formatter's own HTML IS
              the artifact under review — re-rendering it in JSX would preview a different
              document than the one we send. The string is built by the pure formatter from
              htmlEscape'd values (packages/notifications), never from user input at runtime. */}
          <div dangerouslySetInnerHTML={{ __html: mail.html }} />
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            color: "#57606a",
            marginBottom: 6,
          }}
        >
          text/plain alternative
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            background: "#f6f8fa",
            border: "1px solid #d0d7de",
            borderRadius: 8,
            fontSize: 12.5,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          {mail.text}
        </pre>
      </div>
    </div>
  );
}
