// Crypto leaf handlers (extracted VERBATIM from run-graph.ts's execNodeInner switch —
// zero behavior change). DETERMINISTIC WORKFLOW CODE: binding resolution is pure +
// in-workflow; the key fetch + signing/hashing happen in the SAME activity proxies
// (keys never enter workflow history — CLAUDE.md Tier-1 #4).
import {
  resolveHmac,
  resolveHash,
  resolveJwt,
  asNodeConfig,
} from "@naary/dsl/dist/workflow";
import type { NodeOutputMap } from "@naary/dsl";
import { callHmac, callHash, callJwt, callTotp } from "../proxies";
import type { NodeHandler } from "./contract";

export const handleHmac: NodeHandler = async ({ cfg, ctx, node, metaFor }) => {
  // Binding resolution is deterministic (pure ctx read); the key fetch +
  // signing happen in the activity (the key never enters workflow history).
  const hmacCfg = asNodeConfig(cfg, "hmac");
  const result = await callHmac(
    resolveHmac(hmacCfg, ctx),
    ctx.__input,
    metaFor(node.id),
  );
  ctx[node.id] = {
    digest: result.digest,
  } satisfies NodeOutputMap["hmac"];
  return;
};

export const handleHash: NodeHandler = async ({ cfg, ctx, node, metaFor }) => {
  // Keyless digest. Binding resolution is deterministic (pure ctx read); the hash
  // (node:crypto) runs in the activity, out of the deterministic bundle.
  const hashCfg = asNodeConfig(cfg, "hash");
  const result = await callHash(
    resolveHash(hashCfg, ctx),
    ctx.__input,
    metaFor(node.id),
  );
  ctx[node.id] = {
    digest: result.digest,
  } satisfies NodeOutputMap["hash"];
  return;
};

export const handleJwt: NodeHandler = async ({ cfg, ctx, node, metaFor }) => {
  const jwtCfg = asNodeConfig(cfg, "jwt");
  const result = await callJwt(
    resolveJwt(jwtCfg, ctx),
    ctx.__input,
    metaFor(node.id),
  );
  ctx[node.id] = { token: result.token } satisfies NodeOutputMap["jwt"];
  return;
};

export const handleTotp: NodeHandler = async ({ cfg, ctx, node, metaFor }) => {
  // No bindings: the seed comes from the connection, the time from the clock
  // — both handled in the activity. Output is the current code.
  const totpCfg = asNodeConfig(cfg, "totp");
  const result = await callTotp(totpCfg, ctx.__input, metaFor(node.id));
  ctx[node.id] = { code: result.code } satisfies NodeOutputMap["totp"];
  return;
};
