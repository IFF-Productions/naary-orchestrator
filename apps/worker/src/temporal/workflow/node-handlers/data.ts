// Data-fetch / DB / vector leaf handlers (extracted VERBATIM from run-graph.ts's
// execNodeInner switch — zero behavior change). DETERMINISTIC WORKFLOW CODE: binding
// resolution is pure + in-workflow; the I/O (auth fetch, egress check, HTTP/DB/embed)
// runs in the SAME activity proxies run-graph.ts uses. Cost-bearing handlers return
// their `costUsd` DELTA; the dispatch accumulates it + stamps `ctx.__costUsd`.
import {
  getByPath,
  resolveHttpRequest,
  resolveGraphQL,
  resolveSqlQuery,
  resolveSqlExec,
  resolveFirestoreQuery,
  resolveFirestoreWrite,
  resolveRss,
  asNodeConfig,
} from "@naary/dsl/dist/workflow";
import type { NodeOutputMap } from "@naary/dsl";
import {
  callPoll,
  callHttpRequest,
  callGraphQL,
  callKafkaPublish,
  callSqlQuery,
  callSqlExec,
  callFirestoreQuery,
  callFirestoreWrite,
  callRssRead,
  callVectorUpsert,
  callVectorQuery,
  retryOverride,
} from "../proxies";
import type { NodeHandler } from "./contract";

export const handlePollTrigger: NodeHandler = async ({
  cfg,
  ctx,
  node,
  runCtx,
}) => {
  // Entry node: fetch the URL + detect change vs the persisted cursor (keyed by
  // workflowKey so it spans the scheduled runs). Output {changed, body}; branch
  // on `<id>.changed` to no-op when nothing's new.
  const pollCfg = asNodeConfig(cfg, "pollTrigger");
  const r = await callPoll(pollCfg, {
    tenantId: runCtx.tenantId,
    environmentId: runCtx.environmentId, // env-scoped cursor; absent = legacy run → default env (in-activity)
    workflowKey: runCtx.workflowKey ?? "",
    nodeId: node.id,
  });
  ctx[node.id] = {
    changed: r.changed,
    body: r.body,
  } satisfies NodeOutputMap["pollTrigger"];
  return;
};

export const handleHttpRequest: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Binding resolution is deterministic graph work (pure ctx path-reads), so
  // it runs HERE; the I/O (auth fetch, egress check, fetch) is in the activity.
  const httpCfg = asNodeConfig(cfg, "httpRequest");
  const over = retryOverride(node.retry, 150_000);
  const result = await (over?.callHttpRequest ?? callHttpRequest)(
    resolveHttpRequest(httpCfg, ctx),
    ctx.__input,
    metaFor(node.id),
  );
  // Expose the response as {status, headers, body} so edges branch on
  // `<nodeId>.status` (the HTTP code), per the node's behavior contract.
  ctx[node.id] = {
    status: result.httpStatus,
    headers: result.headers,
    body: result.body,
  } satisfies NodeOutputMap["httpRequest"];
  return { costUsd: result.costUsd };
};

export const handleGraphQL: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Binding resolution is deterministic graph work (pure ctx path-reads); the POST + egress
  // check + $secrets resolution are in the activity. `{{ $secrets.X }}` stays literal here.
  const gqlCfg = asNodeConfig(cfg, "graphQL");
  const over = retryOverride(node.retry, 150_000);
  const result = await (over?.callGraphQL ?? callGraphQL)(
    resolveGraphQL(gqlCfg, ctx),
    ctx.__input,
    metaFor(node.id),
  );
  // Expose {data, errors, httpStatus} so edges branch on `<id>.errors` (GraphQL returns
  // 200-with-errors) or read `<id>.data`.
  ctx[node.id] = {
    data: result.data,
    errors: result.errors,
    httpStatus: result.httpStatus,
  } satisfies NodeOutputMap["graphQL"];
  return { costUsd: result.costUsd };
};

export const handleKafkaPublish: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Everything determinable is resolved HERE (template substitution already happened upstream);
  // the brokers, credentials and socket live in the activity. `value` is passed through as-is —
  // the activity decides string-vs-JSON, so the workflow never has to serialize and stays
  // byte-identical on replay.
  const kafkaCfg = asNodeConfig(cfg, "kafkaPublish");
  const result = await callKafkaPublish(
    {
      connectionId: kafkaCfg.connectionId,
      topic: kafkaCfg.topic,
      value: kafkaCfg.value,
      key: kafkaCfg.key,
      headers: kafkaCfg.headers,
      correlationId: kafkaCfg.correlationId,
      replyTopic: kafkaCfg.replyTopic,
      acks: kafkaCfg.acks,
      timeoutMs: kafkaCfg.timeoutMs,
      costUsd: kafkaCfg.costUsd,
    },
    ctx.__input,
    metaFor(node.id),
  );
  // {topic, partition, offset} — the message's identity, so a downstream node can correlate a
  // reply without a lookup table.
  ctx[node.id] = result.output satisfies NodeOutputMap["kafkaPublish"];
  return { costUsd: result.costUsd };
};

export const handleSqlQuery: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Param binding is deterministic graph work (pure ctx path-reads); the DSN
  // read + DB query (read-only) are in the activity. The sql text is never
  // built from bindings — only the params array (no SQL injection).
  const sqlCfg = asNodeConfig(cfg, "sqlQuery");
  const over = retryOverride(node.retry, 150_000);
  const result = await (over?.callSqlQuery ?? callSqlQuery)(
    resolveSqlQuery(sqlCfg, ctx),
    ctx.__input,
    metaFor(node.id),
  );
  // Expose {rows, rowCount} so edges branch on `<nodeId>.rowCount`.
  ctx[node.id] = {
    rows: result.rows,
    rowCount: result.rowCount,
  } satisfies NodeOutputMap["sqlQuery"];
  return { costUsd: result.costUsd };
};

export const handleSqlExec: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // A WRITE (INSERT/UPDATE/DELETE). Same binding rules as sqlQuery (params only,
  // never the SQL text); the DSN read + transactional write are in the activity,
  // which runs at-most-once (writes aren't idempotent).
  const execCfg = asNodeConfig(cfg, "sqlExec");
  const result = await callSqlExec(
    resolveSqlExec(execCfg, ctx),
    ctx.__input,
    metaFor(node.id),
  );
  // Expose {rowsAffected} so edges branch on `<nodeId>.rowsAffected`.
  ctx[node.id] = {
    rowsAffected: result.rowsAffected,
  } satisfies NodeOutputMap["sqlExec"];
  return { costUsd: result.costUsd };
};

export const handleFirestoreQuery: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // Binding resolution is deterministic graph work (pure ctx path-reads); the OAuth token
  // read, the egress-guarded HTTPS call, and the typed-value decoding all happen in the
  // activity. Reads are idempotent, so this kind honours the per-node retry policy.
  const fsCfg = asNodeConfig(cfg, "firestoreQuery");
  const over = retryOverride(node.retry, 150_000);
  const result = await (over?.callFirestoreQuery ?? callFirestoreQuery)(
    resolveFirestoreQuery(fsCfg, ctx),
    ctx.__input,
    metaFor(node.id),
  );
  // Expose {documents, count, truncated} so edges branch on `<nodeId>.count` — or on
  // `<nodeId>.truncated`, which is why a dropped-document bound is in the OUTPUT and not
  // merely a log line.
  ctx[node.id] = {
    documents: result.documents,
    count: result.count,
    truncated: result.truncated,
  } satisfies NodeOutputMap["firestoreQuery"];
  return { costUsd: result.costUsd };
};

export const handleFirestoreWrite: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // A WRITE (set/create/update/delete). No retryOverride: the activity runs at-most-once
  // because `create` has Firestore assign the id, so a retry would create a second
  // document. The plain-JSON → typed-value encoding happens in the activity.
  const writeCfg = asNodeConfig(cfg, "firestoreWrite");
  const result = await callFirestoreWrite(
    resolveFirestoreWrite(writeCfg, ctx),
    ctx.__input,
    metaFor(node.id),
  );
  // Expose {name, documentId, deleted} so a downstream node can address what was written.
  ctx[node.id] = {
    name: result.name,
    documentId: result.documentId,
    deleted: result.deleted,
  } satisfies NodeOutputMap["firestoreWrite"];
  return { costUsd: result.costUsd };
};

export const handleRssRead: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // URL resolution is deterministic (pure ctx read); the fetch + XML parse
  // (I/O, egress-guarded) run in the activity. Output {items, count} so
  // downstream filter/listOps/aggregate can operate on `<nodeId>.items`.
  const rssCfg = asNodeConfig(cfg, "rssRead");
  const over = retryOverride(node.retry, 60_000);
  const result = await (over?.callRssRead ?? callRssRead)(
    resolveRss(rssCfg, ctx),
    ctx.__input,
    metaFor(node.id),
  );
  ctx[node.id] = {
    items: result.items,
    count: result.count,
  } satisfies NodeOutputMap["rssRead"];
  return;
};

export const handleVectorUpsert: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // RAG: input resolved here (pure ctx read); the BYOK embed + pgvector write are in the
  // activity (key never crosses the workflow boundary). Output { upserted }.
  const vuCfg = asNodeConfig(cfg, "vectorUpsert");
  const vuVal = getByPath(ctx[vuCfg.from], vuCfg.path);
  const res = await callVectorUpsert(
    { collection: vuCfg.collection },
    vuVal,
    metaFor(node.id),
  );
  ctx[node.id] = res.result;
  return { costUsd: res.costUsd }; // embedding spend, metered like any activity
};

export const handleVectorQuery: NodeHandler = async ({
  cfg,
  ctx,
  node,
  metaFor,
}) => {
  // RAG: embed the query + return the top-k nearest chunks (activity). Output { matches }.
  const vqCfg = asNodeConfig(cfg, "vectorQuery");
  const vqVal = getByPath(ctx[vqCfg.from], vqCfg.path);
  const res = await callVectorQuery(
    { collection: vqCfg.collection, topK: vqCfg.topK },
    vqVal,
    metaFor(node.id),
  );
  ctx[node.id] = res.result;
  return { costUsd: res.costUsd };
};
