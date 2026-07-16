/**
 * Visual approximation of how Microsoft Teams renders the Adaptive Card the worker POSTs (built by
 * `@naary/notifications` `notificationTeamsCard`). Reads the `{type:"message",attachments:[…]}`
 * envelope and renders the TextBlock header, FactSet, and OpenUrl action buttons. Not Teams — a
 * preview so we can eyeball the card without a live tenant.
 */

type Fact = { title: string; value: string };
type CardAction = { type: string; title: string; url?: string; style?: string };
type CardEl =
  | { type: "TextBlock"; text: string; weight?: string; size?: string }
  | { type: "FactSet"; facts: Fact[] };

const TEAMS = {
  surface: "#f5f5f5",
  card: "#ffffff",
  border: "#e1dfdd",
  text: "#242424",
  muted: "#616161",
  accent: "#6264a7",
  positive: "#237b4b",
  destructive: "#c4314b",
};

export function TeamsCard({ payload }: { payload: unknown }) {
  const p = payload as {
    attachments?: { content?: { body?: CardEl[]; actions?: CardAction[] } }[];
  };
  const content = p.attachments?.[0]?.content;
  const body = content?.body ?? [];
  const actions = content?.actions ?? [];

  return (
    <div
      style={{
        maxWidth: 480,
        background: TEAMS.surface,
        border: `1px solid ${TEAMS.border}`,
        borderRadius: 8,
        padding: 12,
        fontFamily:
          "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif",
        color: TEAMS.text,
      }}
    >
      <div
        style={{
          background: TEAMS.card,
          border: `1px solid ${TEAMS.border}`,
          borderLeft: `3px solid ${TEAMS.accent}`,
          borderRadius: 4,
          padding: "14px 16px",
        }}
      >
        {body.map((el, i) => {
          if (el.type === "TextBlock") {
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered card body
                key={i}
                style={{
                  fontSize: el.size === "Large" ? 18 : 14,
                  fontWeight: el.weight === "Bolder" ? 700 : 400,
                  marginBottom: 8,
                }}
              >
                {el.text}
              </div>
            );
          }
          if (el.type === "FactSet") {
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered card body
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "4px 12px",
                  fontSize: 14,
                }}
              >
                {(el.facts as Fact[]).map((f, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered facts
                  <div key={j} style={{ display: "contents" }}>
                    <div style={{ fontWeight: 700, color: TEAMS.muted }}>
                      {f.title}
                    </div>
                    <div>{f.value}</div>
                  </div>
                ))}
              </div>
            );
          }
          return null;
        })}

        {actions.length > 0 && (
          <div
            style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}
          >
            {actions.map((a, i) => {
              const positive = a.style === "positive";
              const destructive = a.style === "destructive";
              return (
                <a
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered actions
                  key={i}
                  // Untyped card input: omit href rather than emit href="undefined".
                  href={a.url || undefined}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "6px 16px",
                    borderRadius: 4,
                    fontSize: 14,
                    fontWeight: 600,
                    textDecoration: "none",
                    border: `1px solid ${
                      positive
                        ? TEAMS.positive
                        : destructive
                          ? TEAMS.destructive
                          : TEAMS.accent
                    }`,
                    background: positive
                      ? TEAMS.positive
                      : destructive
                        ? TEAMS.destructive
                        : TEAMS.accent,
                    color: "#fff",
                  }}
                >
                  {a.title}
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
