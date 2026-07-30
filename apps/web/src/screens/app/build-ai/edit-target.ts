/**
 * "Which workflow is this chat editing?" — the pure decisions behind Build with AI's
 * EDIT mode.
 *
 * The conversational builder could always edit an existing workflow: `POST /builder/sessions`
 * takes a `workflowKey` and seeds the session's working draft from that workflow's latest saved
 * graph. Nothing in the UI ever passed one, so the seeding was unreachable. The screen now
 * carries a workflow in `?key=` (the same param the canvas reads) and every consequence of that
 * binding is decided here, where it can be tested without a browser.
 *
 * Two of those consequences are the bug #874 fixed on the canvas, in a new place:
 *   · the save must target the BOUND KEY, so it lands as the next VERSION of that workflow
 *     rather than forking a copy and orphaning its run history, schedules and webhook URLs;
 *   · a draft can descend from a version that is no longer the latest, and publishing it
 *     silently would drop whatever was saved in between.
 */
import type { GraphDef } from "@naary/dsl";
import { slugifyName } from "./model";

/** Search param naming the workflow to edit — the same `?key=` the canvas uses. */
export const EDIT_KEY_PARAM = "key";

/** Longest key we'll take off the URL. Matches OpenSessionDto's `@MaxLength(200)`, so an
 *  over-long value fails here with a quiet no-binding instead of a 400 mid-turn. */
const MAX_KEY_LENGTH = 200;

/** The workflow a Build-with-AI chat is bound to. */
export interface EditTarget {
  /** The save target. Never re-derived from a name — that is how #874 forked a copy. */
  workflowKey: string;
  /** The workflow's name AS SAVED — what the banner names, and the fallback save name. */
  name: string;
  /**
   * The saved version this chat's draft descends from, or null when that can't be established.
   *
   * null is NOT "no drift": a RESUMED session snapshotted its draft when it was opened, possibly
   * days ago, and the session row doesn't record which version that was. `staleWarning` therefore
   * treats an unknown base exactly like a drifted one — the alternative is silently publishing a
   * days-old draft over newer work, which is the thing this whole module exists to prevent.
   */
  baseVersion: number | null;
}

/** The workflow key carried in `?key=`, or null when the chat is a from-scratch build. */
export function parseEditKey(search: URLSearchParams): string | null {
  const raw = search.get(EDIT_KEY_PARAM);
  if (!raw) return null;
  const key = raw.trim();
  if (!key || key.length > MAX_KEY_LENGTH) return null;
  return key;
}

/**
 * Arguments for `openBuilderSession`.
 *
 * Returns `undefined` — not `{}` — when there is no target, so the unbound path calls
 * `openBuilderSession(undefined)`, whose body is byte-identical to today's argument-less call
 * (the client does `opts ?? {}`). A from-scratch build must not change at all.
 *
 * `title` is the workflow's name rather than the first prompt: the server only applies
 * `titleIfUnset`, so setting it here wins, and the resume list then reads "Nightly report"
 * instead of "add a slack step".
 */
export function openArgsFor(
  target: EditTarget | null,
): { workflowKey: string; title: string } | undefined {
  if (!target) return undefined;
  return { workflowKey: target.workflowKey, title: target.name };
}

/**
 * `?key=` names a workflow but the binding hasn't resolved yet — no turn may be sent.
 *
 * This window is small and destructive: `openArgsFor(null)` opens an UNBOUND session, which makes
 * the first turn a from-scratch CREATE and the save a slugified fork of the workflow the user
 * thought they were editing. A failed read (`editProblem`) is NOT pending — the binding is
 * established, just unverified, and refusing to let the user continue would be worse than the
 * warning they already have.
 */
export function isBindingPending(
  editKey: string | null,
  target: EditTarget | null,
  editProblem: string | null,
): boolean {
  return !!editKey && !target && !editProblem;
}

/**
 * Where a finished draft gets saved.
 *
 * Bound ⇒ the workflow's own key, which makes `POST /graphs` mint v(n+1) of it (an existing key
 * is an EDIT in GraphsService.upsert). Unbound ⇒ today's behaviour, a slug of the draft name.
 *
 * The NAME comes from the draft, because a turn may legitimately be "rename this to X" and the
 * save path is the only place that can honour it. That is also why `renameNotice` exists: the
 * edit prompt tells the model to preserve the name, but a model that ignores it would otherwise
 * rename the user's workflow silently.
 */
export function saveTargetFor(
  target: EditTarget | null,
  draft: { name: string; graph: GraphDef },
): { workflowKey: string; name: string } {
  const name = draft.name.trim();
  if (target) {
    return { workflowKey: target.workflowKey, name: name || target.name };
  }
  return { workflowKey: slugifyName(draft.name), name: draft.name };
}

/**
 * Why saving this draft might destroy something — or null when it demonstrably can't.
 *
 * `latest` is a fresh read of the bound workflow taken at SAVE time (null = it isn't there any
 * more). Three ways to be unsafe, each named rather than merged into one vague caution:
 * the workflow is gone, the base version is unknown, or the workflow moved on since this chat
 * started. Callers must not save on a non-null return without an explicit confirmation.
 */
export function staleWarning(
  target: EditTarget,
  latest: { version: number } | null,
): string | null {
  if (!latest) {
    return `“${target.name}” no longer exists in this environment — saving would re-create it as a new workflow, without the run history, schedules or webhook URLs of the original.`;
  }
  if (target.baseVersion === null) {
    return `This chat started from an earlier snapshot of “${target.name}”, which is now at v${latest.version}. Saving publishes this draft as v${latest.version + 1} and anything saved since won't be part of it.`;
  }
  if (latest.version !== target.baseVersion) {
    return `“${target.name}” has been saved since this chat started (v${target.baseVersion} → v${latest.version}). Saving publishes this draft as v${latest.version + 1}, dropping those changes.`;
  }
  return null;
}

/** The draft renamed the workflow — say so before the save does it. Null when it didn't. */
export function renameNotice(
  target: EditTarget,
  draftName: string | null,
): string | null {
  const next = draftName?.trim();
  if (!next || next === target.name) return null;
  return `Saving also renames it to “${next}”.`;
}

/** `?key=` pointed at something we couldn't read — the banner says so rather than implying an edit. */
export function loadFailureMessage(workflowKey: string): string {
  return `Couldn't load “${workflowKey}” — it may have been deleted, or belong to a different environment. Check before you save.`;
}

/** The workflow a resumed session was editing has since been deleted. */
export function deletedWorkflowMessage(workflowKey: string): string {
  return `The workflow this chat was editing (“${workflowKey}”) no longer exists here. The draft and conversation are intact, but saving would create a new workflow.`;
}

/**
 * The server opened the session but seeded NOTHING.
 *
 * The stage is drawn from the client's own `GET /graphs/:key`; the session's draft comes from a
 * separate server-side `getLatest`, which returns null on a miss and leaves `currentGraph` empty.
 * The turn endpoint then passes no `previous`, so the first turn becomes a CREATE — the model
 * invents a workflow and the bound save path publishes the invention as the next version of a
 * real workflow, under a banner that says "editing". Refusing the turn is the only honest move.
 */
export function seedMissingMessage(target: EditTarget): string {
  return `Couldn't open “${target.name}” for editing — the workspace didn't return its saved graph, so a message now would build a NEW workflow instead of changing this one. Reload and try again.`;
}
