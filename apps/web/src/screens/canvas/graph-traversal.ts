// Pure graph-traversal helpers for the canvas editor (extracted verbatim from CanvasPage):
// downstream (stale-marking after an edit) and upstream (the dock's INPUT DATA) node walks.

/** All node ids reachable downstream of `id` (for stale-marking after an edit). */
export function downstreamOf(
  id: string,
  edges: { source: string; target: string }[],
): Set<string> {
  const out = new Set<string>();
  const queue = edges.filter((e) => e.source === id).map((e) => e.target);
  while (queue.length) {
    const n = queue.shift();
    if (!n || out.has(n)) continue;
    out.add(n);
    for (const e of edges) if (e.source === n) queue.push(e.target);
  }
  return out;
}

/** All node ids upstream of `id` (BFS, nearest first) — the dock's INPUT DATA. */
export function upstreamOf(
  id: string,
  edges: { source: string; target: string }[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const queue = edges.filter((e) => e.target === id).map((e) => e.source);
  while (queue.length) {
    const n = queue.shift();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    for (const e of edges) if (e.target === n) queue.push(e.source);
  }
  return out;
}
