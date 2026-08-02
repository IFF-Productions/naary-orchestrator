#!/usr/bin/env node
/**
 * Notification screenshot harness (#987) — renders the Storybook notification previews and
 * captures ONE PNG per story, plus an optional before/after contact sheet.
 *
 * Committed for the same reason `responsive-audit.mjs` is: a Slack/Teams change is a VISUAL
 * change, its evidence is a picture, and every pass so far rebuilt the capture from scratch.
 * The stories render the REAL `@naary/notifications` formatter output (Storybook aliases the
 * package to source), so what these PNGs show is byte-for-byte what the worker POSTs.
 *
 *   pnpm --filter @naary/web build-storybook -o /tmp/sb
 *   node apps/web/scripts/notification-shots.mjs --sb /tmp/sb --out /tmp/shots/after
 *   node apps/web/scripts/notification-shots.mjs --sheet --before /tmp/shots/before \
 *        --after /tmp/shots/after --out docs/notifications-before-after.png
 *
 * `--sheet` needs no browser build — it stitches PNGs already captured (a page of <img>
 * data-URIs, screenshotted), so the before column can come from a run on the previous commit.
 */
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] ?? true]);
    return acc;
  }, []),
);

/** The stories to capture, in reading order, with the label used on the contact sheet. */
const STORIES = [
  ["notifications-preview--slack-run-failed", "run_failed"],
  ["notifications-preview--slack-run-failed-status", "run_failed (status)"],
  [
    "notifications-preview--slack-run-failed-bare",
    "run_failed (nothing known)",
  ],
  ["notifications-preview--slack-approval-pending", "approval_pending"],
  ["notifications-preview--slack-approval-reminder", "approval — reminder"],
  ["notifications-preview--slack-approval-escalation", "approval — escalation"],
  ["notifications-preview--slack-budget-threshold", "budget_threshold"],
  ["notifications-preview--slack-promotion", "promotion"],
  ["notifications-preview--slack-fix-proposal", "fix_proposal"],
  ["notifications-preview--slack-no-links", "no links (no APP_BASE_URL)"],
  ["notifications-preview--slack-light-theme", "light theme"],
];

/** The email stories (#1059). Separate list because an email capture is TALLER than a chat
 *  message — it shows the subject, the HTML body and the text/plain body at once. */
const EMAIL_STORIES = [
  ["notifications-preview--email-run-failed", "run_failed"],
  ["notifications-preview--email-run-failed-status", "run_failed (status)"],
  [
    "notifications-preview--email-run-failed-bare",
    "run_failed (nothing known)",
  ],
  ["notifications-preview--email-approval-pending", "approval_pending"],
  ["notifications-preview--email-approval-reminder", "approval — reminder"],
  ["notifications-preview--email-approval-escalation", "approval — escalation"],
  ["notifications-preview--email-budget-threshold", "budget_threshold"],
  ["notifications-preview--email-promotion", "promotion"],
  ["notifications-preview--email-fix-proposal", "fix_proposal"],
  ["notifications-preview--email-no-links", "no links (no APP_BASE_URL)"],
];

/** Which set to capture / stitch: `--channel email` for the email previews (#1059), the Slack
 *  set otherwise. BOTH halves of the script read this, so a sheet can never stitch one
 *  channel's labels onto another channel's shots. */
const SET = args.channel === "email" ? EMAIL_STORIES : STORIES;
const CHANNEL = args.channel === "email" ? "Email" : "Slack";
const ISSUE = args.channel === "email" ? "#1059" : "#987";

async function capture() {
  const SB = args.sb ?? "/tmp/sb";
  const OUT = args.out ?? "/tmp/shots";
  mkdirSync(OUT, { recursive: true });

  const MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".png": "image/png",
    ".map": "application/json",
  };
  const server = createServer((req, res) => {
    const p = decodeURIComponent(req.url.split("?")[0]);
    const file = join(SB, p === "/" ? "/index.html" : p);
    try {
      const body = readFileSync(file);
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("nope");
    }
  });
  await new Promise((r) => server.listen(0, r));
  const PORT = server.address().port;

  const browser = await chromium.launch();
  const page = await browser.newPage({
    // An email story is much taller than a chat message (subject chrome + HTML body +
    // text/plain body). Playwright stitches an element taller than the viewport, but the
    // seam lands on unpainted page and comes back black — so give the tall set the room.
    viewport: { width: 760, height: args.channel === "email" ? 1600 : 700 },
    deviceScaleFactor: 2,
  });
  const captured = [];
  for (const [id, label] of SET) {
    await page.goto(
      `http://localhost:${PORT}/iframe.html?id=${id}&viewMode=story`,
      { waitUntil: "networkidle" },
    );
    // `networkidle` fires while Storybook is still on its "preparing story" splash — wait for
    // the story to actually mount into #storybook-root, else every capture is of a loader.
    await page.waitForFunction(
      () =>
        (document.querySelector("#storybook-root")?.children.length ?? 0) > 0,
      null,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(150); // fonts/layout settle
    // Screenshot the padded surface wrapper so the message sits on the same Slack-coloured
    // background it would in the client. Storybook wraps the story in a `display: contents`
    // div, which has no box and cannot be screenshotted — walk past any such wrapper.
    await page.evaluate(() => {
      let el = document.querySelector("#storybook-root")?.firstElementChild;
      while (el && getComputedStyle(el).display === "contents")
        el = el.firstElementChild;
      // The story stretches its surface to the viewport; shrink it to the message so the
      // capture is the notification, not a screenful of empty channel.
      if (el instanceof HTMLElement && el.style.minHeight === "100vh")
        el.style.minHeight = "auto";
      el?.setAttribute("data-shot", "");
    });
    const el = page.locator("[data-shot]").first();
    const file = join(OUT, `${id}.png`);
    try {
      await el.screenshot({ path: file });
      captured.push([id, label]);
    } catch (e) {
      console.error(`! ${id}: ${e.message}`);
    }
  }
  await browser.close();
  server.close();
  console.log(`captured ${captured.length}/${SET.length} → ${OUT}`);
}

/** Stitch before/after PNGs into one contact sheet (a rendered HTML page, screenshotted). */
async function sheet() {
  const BEFORE = args.before;
  const AFTER = args.after;
  const OUT = args.out ?? "notifications-before-after.png";
  const dataUri = (dir, id) => {
    const f = join(dir, `${id}.png`);
    return existsSync(f)
      ? `data:image/png;base64,${readFileSync(f).toString("base64")}`
      : null;
  };
  const rows = SET.map(([id, label]) => {
    const b = BEFORE ? dataUri(BEFORE, id) : null;
    const a = AFTER ? dataUri(AFTER, id) : null;
    const cell = (src, missing) =>
      src ? `<img src="${src}">` : `<div class="missing">${missing}</div>`;
    // Caption ABOVE the image: the two columns have different heights, so a caption below
    // would float mid-column and read as belonging to the wrong shot.
    return `<section><h2>${label}</h2><div class="pair">
      <figure><figcaption>before</figcaption>${cell(b, "story did not exist before")}</figure>
      <figure><figcaption>after</figcaption>${cell(a, "not captured")}</figure>
    </div></section>`;
  }).join("\n");
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#0d1117;color:#e6edf3;
      font:14px/1.4 -apple-system,'Segoe UI',Roboto,sans-serif;width:1360px}
    h1{font-size:20px;margin:0 0 4px} p.sub{color:#8b949e;margin:0 0 20px}
    section{margin:0 0 26px} h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;
      color:#8b949e;margin:0 0 8px;border-bottom:1px solid #21262d;padding-bottom:6px}
    .pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
    figure{margin:0} img{width:100%;display:block;border-radius:8px}
    figcaption{color:#8b949e;font-size:12px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em}
    .missing{border:1px dashed #30363d;border-radius:8px;padding:28px;color:#6e7681;text-align:center}
  </style>
  <h1>${CHANNEL} notifications — before / after (${ISSUE})</h1>
  <p class="sub">Rendered from the real @naary/notifications formatter output via Storybook.</p>
  ${rows}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1408, height: 900 },
    deviceScaleFactor: 1,
  });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: OUT, fullPage: true });
  await browser.close();
  console.log(`sheet → ${OUT}`);
}

if (args.sheet) await sheet();
else await capture();
