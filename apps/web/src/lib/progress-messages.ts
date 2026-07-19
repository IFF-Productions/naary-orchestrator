/**
 * Playful, rotating status copy for the "Build with AI" generator, shown on a ~2.5s
 * timer while the model streams a workflow onto the canvas. Pure + unit-tested
 * (test/progress-messages.spec.ts) — `nextProgressMessage` never returns the same line
 * twice in a row, and takes an injectable rng so the no-repeat guarantee is testable.
 */

export const PROGRESS_MESSAGES: readonly string[] = [
  "Sketching the trigger…",
  "Wiring the nodes…",
  "Teaching it your rules…",
  "Picking the right models…",
  "Connecting the dots…",
  "Reading between your lines…",
  "Laying out the canvas…",
  "Double-checking the wiring…",
  "Naming things (the hard part)…",
  "Almost there…",
];

/**
 * Pick a random message that is NOT `prev` (so it never repeats back-to-back). Pass a
 * deterministic `rng` (returns [0,1)) in tests; defaults to Math.random. With a single
 * message the same one is returned (no other choice); the list has many, so that's moot.
 */
export function nextProgressMessage(
  prev: string | null,
  rng: () => number = Math.random,
): string {
  const pool =
    prev === null
      ? PROGRESS_MESSAGES
      : PROGRESS_MESSAGES.filter((m) => m !== prev);
  const choices = pool.length > 0 ? pool : PROGRESS_MESSAGES;
  const i = Math.min(choices.length - 1, Math.floor(rng() * choices.length));
  return choices[i];
}
