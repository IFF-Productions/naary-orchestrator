/**
 * Pure shaping between the workflow EXPORT doc (GET /workflows/:key) and the IMPORT
 * body (PUT /workflows/:key). Kept pure so the round-trip is unit-testable.
 */

/** What GET /workflows/:key returns — the export document. */
export interface WorkflowExport {
  workflowKey: string;
  name: string;
  version?: number;
  graph: unknown;
}

/** What PUT /workflows/:key expects as its body. */
export interface WorkflowImportBody {
  name: string;
  graph: unknown;
}

export interface ImportOverrides {
  /** Override the key to PUT to (defaults to the doc's workflowKey). */
  key?: string;
  /** Override the name (defaults to the doc's name). */
  name?: string;
}

/**
 * Resolve the target key + PUT body from an export doc and optional overrides.
 * Throws if no key can be determined.
 */
export function toImport(
  doc: Partial<WorkflowExport>,
  overrides: ImportOverrides = {},
): { key: string; body: WorkflowImportBody } {
  const key = overrides.key ?? doc.workflowKey;
  if (!key) {
    throw new Error(
      "No workflow key: the file has no `workflowKey` and no --key was given.",
    );
  }
  const name = overrides.name ?? doc.name ?? key;
  return { key, body: { name, graph: doc.graph } };
}
