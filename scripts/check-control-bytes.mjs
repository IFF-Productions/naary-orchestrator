#!/usr/bin/env node
/**
 * Fail if a tracked source file contains a RAW control byte (anything below 0x20 that isn't tab,
 * newline or carriage return).
 *
 * WHY THIS IS WORTH A CHECK: grep classifies any file containing a NUL as BINARY and prints only
 * `Binary file … matches`. Piped or filtered — `grep -rn foo src | grep -v test` — that becomes NO
 * OUTPUT AT ALL. A single invisible byte silently removes the whole file from every text search:
 * code review, `grep`-based CI steps, and audits. It cost this repo a wrong conclusion in #805,
 * where a 17KB worker file was invisible to a duplicate-constant scan and the missing hit was
 * written off as a false positive.
 *
 * The bytes themselves are usually intentional — NUL as a key separator that user input can't
 * contain, a control character in a sanitizer's test fixture. Nothing here argues against the
 * VALUE; only against writing it as a raw byte. `\0` and `\x1f` are the same characters at runtime
 * and leave the file greppable, which is why this check is safe to make blocking.
 *
 * Run: node scripts/check-control-bytes.mjs   (pnpm check:control-bytes)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Text-ish sources where a raw control byte is a mistake rather than payload. Binary assets
 *  (images, fonts, .ico) are excluded by construction — they are supposed to contain any byte. */
const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".html",
  ".yml",
  ".yaml",
  ".sql",
  ".sh",
];

/** Tab, LF and CR are the legitimate control characters in a text file. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

/** git ls-files rather than a directory walk: it already excludes gitignored output (dist,
 *  node_modules, coverage) and can't drift from what is actually committed. */
const tracked = execFileSync("git", ["ls-files", "-z"], {
  // utf8, NOT latin1: git emits raw filename bytes, so a latin1 decode turns a non-ASCII path into
  // mojibake that readFileSync then can't open. The skip below would drop it with no output —
  // silence indistinguishable from a pass, which is the exact failure this check exists to prevent.
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean)
  .filter((f) => EXTENSIONS.some((ext) => f.endsWith(ext)));

const offenders = [];
const unreadable = [];
for (const file of tracked) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch (err) {
    // Tracked but not on disk is normal in a dirty tree (a staged deletion). Anything else means
    // this check did NOT look at a file it was supposed to — reported, never silently skipped.
    if (err?.code !== "ENOENT") unreadable.push(`${file} (${err?.code ?? err})`);
    continue;
  }
  let line = 1;
  for (const byte of buf) {
    if (byte === 0x0a) line += 1;
    else if (byte < 0x20 && !ALLOWED.has(byte)) {
      offenders.push({ file, line, byte });
    }
  }
}

if (unreadable.length > 0) {
  console.error(`Could not read ${unreadable.length} tracked file(s):`);
  for (const u of unreadable) console.error(`  ${u}`);
  process.exit(1);
}

if (offenders.length > 0) {
  const hex = (b) => `0x${b.toString(16).padStart(2, "0")}`;
  console.error(
    `Raw control byte(s) in ${new Set(offenders.map((o) => o.file)).size} source file(s):\n`,
  );
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${hex(o.byte)}`);
  }
  console.error(
    [
      "",
      "A file containing one of these reads as BINARY to grep, so it silently disappears from",
      'every text search ("Binary file … matches", and nothing at all once piped).',
      "",
      "Write the character as an escape instead — identical at runtime, greppable in source:",
      "    `${a}\\0${b}`     not a raw NUL",
      '    "\\x1f"           not a raw 0x1f',
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`No raw control bytes in ${tracked.length} tracked source files.`);
