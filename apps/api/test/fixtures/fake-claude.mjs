#!/usr/bin/env node
// A stand-in for `claude -p --output-format json` that reproduces the reported stdin-blocking bug:
// it emits its JSON envelope ONLY after stdin reaches EOF (the real CLI blocks waiting for stdin).
// If stdin is never closed, it behaves like the failing CLI — warns on stderr and exits 1. So the
// integration test passes ONLY when the exec wrapper closes the child's stdin.
const GRAPH = {
  name: "Fake flow",
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "end", type: "end" },
  ],
  edges: [{ from: "start", to: "end" }],
};

let done = false;
const fail = setTimeout(() => {
  if (done) return;
  done = true;
  process.stderr.write(
    "Warning: no stdin data received in 3s, proceeding without it. redirect stdin: < /dev/null",
  );
  process.exit(1);
}, 800);

process.stdin.on("end", () => {
  if (done) return;
  done = true;
  clearTimeout(fail);
  process.stdout.write(
    JSON.stringify({
      type: "result",
      result: JSON.stringify(GRAPH),
      is_error: false,
    }),
  );
  process.exit(0);
});
process.stdin.resume();
