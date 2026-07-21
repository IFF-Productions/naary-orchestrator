export function ErrorLine({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: "var(--text-sm)",
        color: "var(--state-error)",
        margin: "8px 0",
      }}
    >
      {text}
    </div>
  );
}
