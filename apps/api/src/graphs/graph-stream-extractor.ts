/**
 * Incremental extractor for a STREAMING free-form graph JSON — the model emits the
 * graph object token-by-token (see graph-generator.service `callModelStreaming`), and
 * we want to surface each complete node / edge onto the canvas the moment its closing
 * `}` arrives, rather than waiting for the whole graph.
 *
 * `scanGraphElements` is a pure, tolerant brace-depth scanner over a (possibly partial)
 * JSON string: it walks the accumulating buffer once, tracks string/escape state and
 * container nesting, and returns EVERY complete `{…}` element found so far inside the
 * top-level `nodes:[…]` and `edges:[…]` arrays, plus the top-level `name` string once
 * it's complete. It only emits an element when its own closing brace is present and it
 * parses — never a half-object — so the result grows monotonically as more text arrives
 * (a closed, parseable element never mutates). Leading prose / a ```json fence before
 * the root `{` (and any trailing fence) are naturally ignored: nothing is tracked until
 * the first top-level `{`.
 *
 * `createGraphStreamExtractor` wraps it in a tiny stateful diff: feed it the CUMULATIVE
 * text on each `push` and it returns only what's NEW since the last push (by count), so
 * each node/edge is yielded exactly once, in source order. Unit-tested in
 * test/graph-stream-extractor.spec.ts.
 */

/** All complete elements currently extractable from `text` (idempotent, tolerant). */
export function scanGraphElements(text: string): {
  name?: string;
  nodes: unknown[];
  edges: unknown[];
} {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  let name: string | undefined;

  interface Frame {
    /** true = array container, false = object container. */
    arr: boolean;
    /** For a direct child array of the root object: which one. */
    kind?: "nodes" | "edges";
    /** Object only: next string is a key (vs a value). */
    expectKey: boolean;
    /** Object only: the key the current value is being assigned to. */
    curKey: string | null;
    /** Set when this object is a direct element of a nodes/edges array. */
    elemStart?: number;
    elemKind?: "nodes" | "edges";
  }

  const stack: Frame[] = [];
  let inStr = false;
  let esc = false;
  let strStart = -1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (c === "\\") {
        esc = true;
      } else if (c === '"') {
        inStr = false;
        const top = stack[stack.length - 1];
        if (top && !top.arr) {
          if (top.expectKey) {
            // A key. Decode it so `curKey` compares cleanly (handles \uXXXX / escapes).
            try {
              top.curKey = JSON.parse(text.slice(strStart, i + 1)) as string;
            } catch {
              top.curKey = null;
            }
          } else if (
            stack.length === 1 &&
            top.curKey === "name" &&
            name === undefined
          ) {
            // The workflow name: a string value of the ROOT object's `name` key only
            // (depth 1) — never a `name` buried inside a node's config.
            try {
              name = JSON.parse(text.slice(strStart, i + 1)) as string;
            } catch {
              /* leave undefined; a later push / the result frame corrects it */
            }
          }
        }
      }
      continue;
    }

    if (c === '"') {
      inStr = true;
      strStart = i;
      continue;
    }

    if (stack.length === 0) {
      // Not tracking anything yet — skip prose / fences until the root object opens.
      if (c === "{") stack.push({ arr: false, expectKey: true, curKey: null });
      continue;
    }

    const top = stack[stack.length - 1];
    if (c === "{") {
      const isElement =
        top.arr && (top.kind === "nodes" || top.kind === "edges");
      stack.push({
        arr: false,
        expectKey: true,
        curKey: null,
        ...(isElement ? { elemStart: i, elemKind: top.kind } : {}),
      });
    } else if (c === "[") {
      // A direct child array of the ROOT object named nodes/edges is the one we scan.
      const kind =
        !top.arr &&
        stack.length === 1 &&
        (top.curKey === "nodes" || top.curKey === "edges")
          ? top.curKey
          : undefined;
      stack.push({ arr: true, kind, expectKey: false, curKey: null });
    } else if (c === "}") {
      const closed = stack.pop();
      if (closed && closed.elemStart !== undefined) {
        try {
          const obj = JSON.parse(
            text.slice(closed.elemStart, i + 1),
          ) as unknown;
          if (closed.elemKind === "nodes") nodes.push(obj);
          else if (closed.elemKind === "edges") edges.push(obj);
        } catch {
          /* not yet parseable — ignore (shouldn't happen once `}` balances) */
        }
      }
    } else if (c === "]") {
      stack.pop();
    } else if (c === ":") {
      if (top && !top.arr) top.expectKey = false;
    } else if (c === ",") {
      if (top && !top.arr) {
        top.expectKey = true;
        top.curKey = null;
      }
    }
    // whitespace / primitives / other chars: no structural effect
  }

  return { ...(name !== undefined ? { name } : {}), nodes, edges };
}

/**
 * Stateful wrapper: `push(cumulativeText)` returns only the elements that became
 * complete since the previous push (by count over the monotonic scan), so each node /
 * edge is emitted exactly once, in order. `name` is emitted at most once.
 */
export function createGraphStreamExtractor(): {
  push(cumulativeText: string): {
    name?: string;
    nodes: unknown[];
    edges: unknown[];
  };
} {
  let nodeCount = 0;
  let edgeCount = 0;
  let nameEmitted = false;
  return {
    push(cumulativeText: string) {
      const { name, nodes, edges } = scanGraphElements(cumulativeText);
      const newNodes = nodes.slice(nodeCount);
      const newEdges = edges.slice(edgeCount);
      nodeCount = nodes.length;
      edgeCount = edges.length;
      let outName: string | undefined;
      if (!nameEmitted && typeof name === "string" && name.trim() !== "") {
        nameEmitted = true;
        outName = name;
      }
      return {
        ...(outName !== undefined ? { name: outName } : {}),
        nodes: newNodes,
        edges: newEdges,
      };
    },
  };
}
