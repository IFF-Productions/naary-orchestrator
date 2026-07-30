#!/usr/bin/env node
/**
 * Responsive audit harness (#511) — measures the BUILT Storybook at phone/tablet widths.
 *
 * Committed because every pass on #511 so far rebuilt this probe from scratch and one of them
 * got it wrong in a way that inverted the conclusion: it asked
 * `documentElement.scrollWidth > clientWidth`, and `styles/global.css` clamps the root with
 * `max-width: 100%; overflow-x: hidden`. That probe CANNOT report overflow however much is
 * clipped — three passes read "zero overflow on every screen" by construction (PR #706).
 *
 * So, deliberately:
 *  - overflow is measured PER ELEMENT (right edge vs the viewport), never from the root;
 *  - content inside an `overflow-x: auto` ancestor is NOT flagged as clipped — that pattern is
 *    intentional here. Instead the scroller is reported by how much it HIDES
 *    (`scrollWidth - clientWidth`): "it scrolls" and "a user will find it" are different claims;
 *  - a sub-44px control is reported with the distance to its nearest interactive neighbour,
 *    because the fix for a cramped cluster is more space, not a bigger target (a 44px hit area
 *    that overlaps its neighbour turns a near-miss into a WRONG action);
 *  - an interactive control that sits OUTSIDE the viewport with no scroll that can reach it is
 *    reported separately (`offscreen`). The first three measurements all missed a whole defect
 *    class: `clipped` asks only about the RIGHT edge and only about layout, so a menu rendered
 *    121px past the LEFT edge, or a `position: fixed` popover 78px below the fold, read as clean.
 *    A control the page cannot scroll to is not "cramped" — it does not exist for the user.
 *
 * KNOWN GAP, stated because an unstated one is how this issue kept reporting false clean: the
 * vertical half of `offscreen` only fires inside a `position: fixed` subtree. For an IN-FLOW element
 * below the fold, "unreachable" depends on whether some ancestor can scroll far enough, which is not
 * a rect comparison — so e.g. `screens-runs--populated`'s in-flow re-run menu, measured 214px below
 * the fold at 390×844, is NOT in the `offscreen` count. Treat that number as a floor.
 *
 * `safe` is a conservative flag: it assumes a control is centre-grown in place, so a stacked
 * flow-layout row that would simply reflow (a card getting taller) is still reported unsafe.
 * Read it as "cannot be bumped by a blanket CSS rule", not "cannot be fixed".
 *
 *   pnpm --filter @naary/web build-storybook -o /tmp/sb
 *   node apps/web/scripts/responsive-audit.mjs --sb /tmp/sb --width 390 [--filter screens-settings] [--out out.json]
 */
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const SB = args.sb ?? new URL("./sb", import.meta.url).pathname;
const WIDTH = Number(args.width ?? 390);
const HEIGHT = Number(args.height ?? 844);
const FILTER = args.filter ?? "";
const OUT = args.out ?? null;
const MIN_TOUCH = 44;

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
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("nope");
  }
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const index = JSON.parse(readFileSync(join(SB, "index.json"), "utf8"));
const ids = Object.keys(index.entries).filter((id) => id.includes(FILTER));

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});

// The measurement runs in the page. Returns clipped elements, scroller debt, and small targets.
const PROBE = `(() => {
  const VW = document.documentElement.clientWidth;
  const VH = document.documentElement.clientHeight;
  const MIN = ${MIN_TOUCH};
  const desc = (el) => {
    const t = (el.getAttribute('aria-label') || el.title || el.textContent || '').trim().replace(/\\s+/g,' ').slice(0,40);
    return el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '') + (t ? ' "' + t + '"' : '');
  };
  const all = [...document.querySelectorAll('*')];
  const scrollableAncestor = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return p;
    }
    return null;
  };
  // 1. CLIPPED: right edge past the viewport with no scroller to reach it.
  const clipped = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= VW + 0.5) continue;
    if (scrollableAncestor(el)) continue;
    if (getComputedStyle(el).position === 'fixed') continue;
    clipped.push({ el: desc(el), right: Math.round(r.right), vw: VW, over: Math.round(r.right - VW) });
  }
  // 2. SCROLLER DEBT: how much each horizontal scroller hides.
  const scrollers = [];
  for (const el of all) {
    const ox = getComputedStyle(el).overflowX;
    if (ox !== 'auto' && ox !== 'scroll') continue;
    const hidden = el.scrollWidth - el.clientWidth;
    if (hidden > 4) scrollers.push({ el: desc(el), hidden, pct: Math.round((hidden / el.scrollWidth) * 100) });
  }
  // 3. TOUCH TARGETS: interactive elements smaller than MIN, with nearest-neighbour spacing.
  const SEL = 'button,a[href],input,select,textarea,[role=button],[role=checkbox],[role=switch],[role=tab],[role=menuitem],[tabindex]:not([tabindex="-1"])';
  const inter = [...document.querySelectorAll(SEL)].filter((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled;
  });
  const boxes = inter.map((el) => ({ el, r: el.getBoundingClientRect() }));
  const small = [];
  for (const { el, r } of boxes) {
    if (r.width >= MIN && r.height >= MIN) continue;
    let gap = Infinity, who = null, need = 0;
    const grow = (b) => Math.max(0, MIN - b.width) / 2 + Math.max(0, MIN - b.height) / 2 > 0
      ? Math.max(Math.max(0, MIN - b.width), Math.max(0, MIN - b.height)) / 2 : 0;
    for (const o of boxes) {
      if (o.el === el || el.contains(o.el) || o.el.contains(el)) continue;
      const dx = Math.max(0, Math.max(r.left - o.r.right, o.r.left - r.right));
      const dy = Math.max(0, Math.max(r.top - o.r.bottom, o.r.top - r.bottom));
      const d = Math.hypot(dx, dy);
      if (d < gap) { gap = d; who = desc(o.el); need = grow(r) + grow(o.r); }
    }
    small.push({
      el: desc(el),
      w: Math.round(r.width), h: Math.round(r.height),
      gap: gap === Infinity ? null : Math.round(gap),
      neighbour: who,
      // Safe to CENTRE-grow both this control and its nearest neighbour to MIN without the two
      // hit areas overlapping: each needs (MIN - size)/2 of clearance on the facing side.
      safe: gap === Infinity ? true : gap >= need,
    });
  }
  // 4. OFFSCREEN: interactive controls no scroll can bring into view.
  //
  //  - horizontally: \`styles/global.css\` clamps the root with \`overflow-x: hidden\`, so BOTH edges
  //    are hard walls — a right-anchored popover whose anchor sits left of its own width lands at a
  //    negative \`left\` and is simply gone. Excused when a horizontal scroller can reach it.
  //  - vertically: only inside a \`position: fixed\` subtree. A fixed box does not move with page
  //    scroll, so anything of it past the fold is unreachable — and a popover that also closes on
  //    scroll makes the recovery gesture destroy the thing you were reaching for.
  //
  // NOTE the excusal here is STRICTER than \`clipped\`'s. \`scrollableAncestor\` matches any ancestor
  // whose computed \`overflow-x\` is auto/scroll — and CSS computes \`overflow-x: visible\` to \`auto\`
  // whenever \`overflow-y\` is auto, so every popover with a \`max-height\` scroller counts as one.
  // That is how the -121px menu measured clean: its items sat inside a box that "scrolls
  // horizontally" but has zero horizontal scroll room. Require REAL debt.
  const reachableByScroll = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth - p.clientWidth > 4) return true;
    }
    return false;
  };
  const offscreen = [];
  for (const { el, r } of boxes) {
    const hs = reachableByScroll(el);
    const dxLeft = hs ? 0 : Math.max(0, -r.left);
    const dxRight = hs ? 0 : Math.max(0, r.right - VW);
    // A fixed subtree does not move with page scroll. Walk out to the first fixed ancestor, but
    // stop early at any vertical scroller with REAL scroll room — that one can reach it.
    let fixed = false;
    for (let p = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
        if (p.scrollHeight - p.clientHeight > 4) break;
      }
      if (cs.position === 'fixed') { fixed = true; break; }
    }
    const dyBelow = fixed ? Math.max(0, r.bottom - VH) : 0;
    const dyAbove = fixed ? Math.max(0, -r.top) : 0;
    const worst = Math.max(dxLeft, dxRight, dyBelow, dyAbove);
    if (worst < 1) continue;
    offscreen.push({
      el: desc(el),
      w: Math.round(r.width), h: Math.round(r.height),
      left: Math.round(dxLeft), right: Math.round(dxRight),
      below: Math.round(dyBelow), above: Math.round(dyAbove),
      fixed,
      // Wholly outside — not a clipped edge but an invisible control.
      gone: r.right < 0 || r.left > VW || (fixed && (r.bottom < 0 || r.top > VH)),
    });
  }
  return { clipped, scrollers, small, offscreen, vw: VW, vh: VH };
})()`;

/**
 * Wait for the story to stop changing, rather than for a fixed delay.
 *
 * A fixed wait silently measures the wrong thing twice over: MSW-backed screens paint an empty
 * or loading state first, and a story with a `play` function (the only way to reach a state the
 * default render doesn't show — an open drawer, a draft row) needs its interactions to finish.
 * Probe too early and the screen reports clean because there was nothing on it yet. An earlier
 * sweep here read one async story 6 controls light for exactly this reason.
 */
async function settle(page, { quiet = 3, step = 200, cap = 8000 } = {}) {
  let last = null;
  let stable = 0;
  for (let waited = 0; waited < cap; waited += step) {
    await page.waitForTimeout(step);
    const sig = await page.evaluate(
      () =>
        `${document.body.innerHTML.length}:${document.querySelectorAll("button,a,input,select,textarea").length}`,
    );
    stable = sig === last ? stable + 1 : 0;
    last = sig;
    if (stable >= quiet) return;
  }
}

const results = [];
for (const id of ids) {
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  try {
    await page.goto(`http://localhost:${PORT}/iframe.html?id=${id}&viewMode=story`, {
      waitUntil: "load",
      timeout: 30000,
    });
    await settle(page);
    const r = await page.evaluate(PROBE);
    const bodyText = await page.evaluate(() => document.body.innerText.trim().length);
    results.push({ id, ...r, empty: bodyText < 5, errs });
  } catch (e) {
    results.push({ id, error: String(e).slice(0, 160) });
  }
  await page.close();
}
await browser.close();
server.close();

// ---- report ----
const rank = results
  .filter((r) => !r.error)
  .map((r) => ({
    id: r.id,
    clipped: r.clipped?.length ?? 0,
    maxOver: Math.max(0, ...(r.clipped ?? []).map((c) => c.over)),
    hidden: Math.max(0, ...(r.scrollers ?? []).map((s) => s.hidden)),
    small: r.small?.length ?? 0,
    unsafe: (r.small ?? []).filter((s) => !s.safe).length,
    offscreen: r.offscreen?.length ?? 0,
    gone: (r.offscreen ?? []).filter((o) => o.gone).length,
    maxOff: Math.max(
      0,
      ...(r.offscreen ?? []).map((o) => Math.max(o.left, o.right, o.below, o.above)),
    ),
    empty: r.empty,
  }));

const totals = rank.reduce(
  (a, r) => ({
    clipped: a.clipped + r.clipped,
    small: a.small + r.small,
    unsafe: a.unsafe + r.unsafe,
    offscreen: a.offscreen + r.offscreen,
    gone: a.gone + r.gone,
  }),
  { clipped: 0, small: 0, unsafe: 0, offscreen: 0, gone: 0 },
);
console.log(`\n=== ${WIDTH}×${HEIGHT} — ${rank.length} stories ===`);
console.log(
  `clipped elements: ${totals.clipped}   sub-${MIN_TOUCH}px controls: ${totals.small} (${totals.unsafe} unsafe to bump)`,
);
console.log(
  `UNREACHABLE controls: ${totals.offscreen} (${totals.gone} wholly offscreen)\n`,
);
if (totals.offscreen) {
  console.log("unreachable (no scroll gets there):");
  for (const r of rank
    .filter((r) => r.offscreen)
    .sort((a, b) => b.maxOff - a.maxOff)
    .slice(0, 20))
    console.log(
      `  ${String(r.maxOff).padStart(5)}px out  ${String(r.offscreen).padStart(3)} ctrl (${r.gone} gone)  ${r.id}`,
    );
  console.log("");
}
console.log("top by clipped:");
for (const r of rank.filter((r) => r.clipped).sort((a, b) => b.maxOver - a.maxOver).slice(0, 15))
  console.log(`  ${String(r.maxOver).padStart(5)}px over  ${String(r.clipped).padStart(3)} els  ${r.id}`);
console.log("\ntop by scroller debt (hidden px):");
for (const r of rank.filter((r) => r.hidden).sort((a, b) => b.hidden - a.hidden).slice(0, 15))
  console.log(`  ${String(r.hidden).padStart(5)}px hidden  ${r.id}`);
console.log("\ntop by small targets (safe/unsafe):");
for (const r of rank.filter((r) => r.small).sort((a, b) => b.small - a.small).slice(0, 20))
  console.log(`  ${String(r.small).padStart(3)} small (${r.small - r.unsafe} safe / ${r.unsafe} unsafe)  ${r.id}`);

if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
