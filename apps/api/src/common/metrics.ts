import {
  type Counter,
  type Histogram,
  counter,
  histogram,
} from "@naary/metrics";

/**
 * API metric definitions (registered on import). Labels are low-cardinality only
 * — method + status code + workflowKey — never tenant/run ids.
 */
export const httpRequests: Counter<"method" | "status"> = counter({
  name: "naary_http_requests_total",
  help: "HTTP requests handled by the API",
  labelNames: ["method", "status"],
});

export const httpDuration: Histogram<"method" | "status"> = histogram({
  name: "naary_http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

export const executionsStarted: Counter<"workflowKey"> = counter({
  name: "naary_executions_started_total",
  help: "Workflow executions started via the control plane",
  labelNames: ["workflowKey"],
});
