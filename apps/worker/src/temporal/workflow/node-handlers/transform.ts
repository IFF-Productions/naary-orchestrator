// Pure-transform + parser leaf handlers (extracted VERBATIM from run-graph.ts's
// execNodeInner switch — zero behavior change). DETERMINISTIC WORKFLOW CODE: the pure
// nodes run in-workflow; the parser/random/clock ones defer the side effect to the
// SAME activity proxies run-graph.ts uses.
import {
  getByPath,
  resolveAggregate,
  resolveCompareDatasets,
  resolveFilter,
  resolveIf,
  resolveJson,
  resolveListOps,
  resolveNumber,
  resolveRenameKeys,
  resolveSet,
  resolveSwitch,
  resolveText,
  asNodeConfig,
} from "@naary/dsl";
import type { NodeOutputMap } from "@naary/dsl";
import * as wf from "@temporalio/workflow";
import {
  computeDateTime,
  callXml,
  callHtmlExtract,
  callMarkdown,
  callCsv,
  callEncode,
  callRandom,
} from "../proxies";
import type { NodeHandler } from "./contract";

export const handleSet: NodeHandler = async ({ cfg, ctx, node }) => {
  // Pure node: build the output object from static fields + upstream
  // bindings entirely in the interpreter (deterministic, no I/O, no cost).
  // Output IS the built object, so edges/nodes read `<nodeId>.<field>`.
  const setCfg = asNodeConfig(cfg, "set");
  ctx[node.id] = resolveSet(setCfg, ctx);
  return;
};

export const handleRenameKeys: NodeHandler = async ({ cfg, ctx, node }) => {
  // Pure node: reshape an upstream object's keys, entirely in the interpreter.
  const rkCfg = asNodeConfig(cfg, "renameKeys");
  // #766: the original `rename[k] ?? k` read the PROTOTYPE CHAIN, so an upstream object carrying a
  // literal `constructor` key produced an output key of `"function Object() { [native code] }"` —
  // reachable from an innocent config, since arbitrary API responses do contain such fields.
  // `ownRenameLookup` switches to an own-property lookup + a null-prototype accumulator.
  //
  // Behind patched() because this changes the output of DETERMINISTIC workflow code: an in-flight run
  // would otherwise replay differently and fail with a nondeterminism error (CLAUDE.md: version
  // interpreter changes with workflow.patched()). Histories predating the gate keep the old path.
  ctx[node.id] = resolveRenameKeys(rkCfg, ctx, {
    ownRenameLookup: wf.patched("rename-keys-own-lookup-v1"),
  });
  return;
};

export const handleText: NodeHandler = async ({ cfg, ctx, node }) => {
  // Pure node: one string op on an upstream value → { result }. Deterministic
  // (regex is pure; invalid patterns fail closed to null in resolveText).
  const txtCfg = asNodeConfig(cfg, "text");
  ctx[node.id] = resolveText(txtCfg, ctx);
  return;
};

export const handleFilter: NodeHandler = async ({ cfg, ctx, node }) => {
  // Pure node: keep the upstream array items matching the per-item predicate.
  // Output IS the filtered array (downstream reads `<id>.0` or aggregates it).
  const filterCfg = asNodeConfig(cfg, "filter");
  ctx[node.id] = resolveFilter(filterCfg, ctx);
  return;
};

export const handleAggregate: NodeHandler = async ({ cfg, ctx, node }) => {
  // Pure node: collapse an upstream array → { result }.
  const aggCfg = asNodeConfig(cfg, "aggregate");
  ctx[node.id] = resolveAggregate(aggCfg, ctx);
  return;
};

export const handleListOps: NodeHandler = async ({ cfg, ctx, node }) => {
  // Pure node: sort / limit / dedupe an upstream array → array.
  const loCfg = asNodeConfig(cfg, "listOps");
  ctx[node.id] = resolveListOps(loCfg, ctx);
  return;
};

export const handleCompareDatasets: NodeHandler = async ({
  cfg,
  ctx,
  node,
}) => {
  // Pure node: diff two upstream arrays by key → {added,removed,changed,same}.
  const cdCfg = asNodeConfig(cfg, "compareDatasets");
  ctx[node.id] = resolveCompareDatasets(cdCfg, ctx);
  return;
};

export const handleSwitch: NodeHandler = async ({ cfg, ctx, node }) => {
  // Pure node: pick the first matching rule → { matched }. Downstream edges branch
  // on `<switchId>.matched`. Reuses evaluateCondition (structured, no eval).
  const swCfg = asNodeConfig(cfg, "switch");
  ctx[node.id] = resolveSwitch(swCfg, ctx);
  return;
};

export const handleIf: NodeHandler = async ({ cfg, ctx, node }) => {
  // Pure node: combine predicates with AND/OR → { result }. Downstream edges branch
  // on `<ifId>.result` (eq true / eq false).
  const ifCfg = asNodeConfig(cfg, "if");
  ctx[node.id] = resolveIf(ifCfg, ctx);
  return;
};

export const handleJson: NodeHandler = async ({ cfg, ctx, node }) => {
  // Pure node: JSON parse/stringify (deterministic ES built-ins, no activity).
  // Malformed JSON on parse throws → a node failure onError:"continue" can catch.
  const jsonCfg = asNodeConfig(cfg, "json");
  ctx[node.id] = resolveJson(jsonCfg, ctx);
  return;
};

export const handleNumber: NodeHandler = async ({ cfg, ctx, node }) => {
  // Pure node: one arithmetic op on resolved operands → { result }.
  const numCfg = asNodeConfig(cfg, "number");
  ctx[node.id] = resolveNumber(numCfg, ctx);
  return;
};

export const handleDateTime: NodeHandler = async ({ cfg, ctx, node }) => {
  // The base value is resolved deterministically here (pure ctx read); the
  // CLOCK READ (when source is "now") happens in the activity, since time is
  // non-deterministic and must not touch workflow code.
  const dtCfg = asNodeConfig(cfg, "dateTime");
  const src = dtCfg.source;
  const base =
    !src || src === "now"
      ? null
      : ((getByPath(ctx[src.from], src.path) ?? null) as
          string | number | null);
  ctx[node.id] = await computeDateTime({
    base,
    addSeconds: dtCfg.addSeconds,
  });
  return;
};

export const handleXml: NodeHandler = async ({ cfg, ctx, node, metaFor }) => {
  // Parse XML→object / build object→XML in the activity (parser stays out of
  // the deterministic bundle). Input value resolved here (pure ctx read).
  const xmlCfg = asNodeConfig(cfg, "xml");
  const inputVal = getByPath(ctx[xmlCfg.from], xmlCfg.path);
  const result = await callXml(
    { operation: xmlCfg.operation },
    inputVal,
    metaFor(node.id),
  );
  ctx[node.id] = result.result;
  return;
};

export const handleHtmlExtract: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Pull values from an HTML string by CSS selector. HTML resolved here (pure ctx
  // read); the parse runs in the activity (parser out of the deterministic bundle).
  const htmlCfg = asNodeConfig(cfg, "htmlExtract");
  const htmlVal = getByPath(ctx[htmlCfg.from], htmlCfg.path);
  const res = await callHtmlExtract(
    { extractions: htmlCfg.extractions ?? [] },
    htmlVal,
    metaFor(node.id),
  );
  ctx[node.id] = res.result;
  return;
};

export const handleMarkdown: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Convert an HTML string → Markdown. HTML resolved here (pure ctx read); the parse runs
  // in the activity (parser out of the deterministic bundle, like htmlExtract).
  const mdCfg = asNodeConfig(cfg, "markdown");
  const mdVal = getByPath(ctx[mdCfg.from], mdCfg.path);
  const res = await callMarkdown(mdVal, metaFor(node.id));
  ctx[node.id] = res.result;
  return;
};

export const handleCsv: NodeHandler = async ({ cfg, ctx, node, metaFor }) => {
  // Parse CSV→rows / build rows→CSV. Input resolved here (pure ctx read); the parse
  // runs in the activity (parser out of the deterministic bundle).
  const csvCfg = asNodeConfig(cfg, "csv");
  const csvVal = getByPath(ctx[csvCfg.from], csvCfg.path);
  const res = await callCsv(
    {
      operation: csvCfg.operation,
      header: csvCfg.header,
      delimiter: csvCfg.delimiter,
    },
    csvVal,
    metaFor(node.id),
  );
  ctx[node.id] = res.result;
  return;
};

export const handleEncode: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Input resolved here (pure ctx read); the encode runs in the activity (Buffer for
  // base64/hex isn't in the deterministic bundle). Output { result }.
  const encCfg = asNodeConfig(cfg, "encode");
  const encVal = getByPath(ctx[encCfg.from], encCfg.path);
  const res = await callEncode(
    { operation: encCfg.operation },
    encVal,
    metaFor(node.id),
  );
  ctx[node.id] = { result: res.result };
  return;
};

export const handleRandom: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Generate a fresh random value. Runs in the activity — randomness must never touch
  // deterministic workflow code. No inputs. Output { value }.
  const rndCfg = asNodeConfig(cfg, "random");
  const res = await callRandom(
    {
      operation: rndCfg.operation,
      length: rndCfg.length,
      min: rndCfg.min,
      max: rndCfg.max,
    },
    metaFor(node.id),
  );
  ctx[node.id] = { value: res.value } satisfies NodeOutputMap["random"];
  return;
};
