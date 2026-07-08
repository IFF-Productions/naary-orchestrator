import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type NamedGraph } from "../../lib/api";
import { AutomationEditor } from "./AutomationEditor";

/** Open a saved automation as a Simple-mode step list. */
export function AutomationDetail() {
  const { key } = useParams<{ key: string }>();
  const [data, setData] = useState<NamedGraph | null | "error">(null);

  useEffect(() => {
    if (!key) return;
    let live = true;
    api
      .getGraph(key)
      .then((g) => live && setData(g))
      .catch(() => live && setData("error"));
    return () => {
      live = false;
    };
  }, [key]);

  if (data === "error") {
    return (
      <div
        style={{
          padding: "22px 28px",
          fontSize: "var(--text-body)",
          color: "var(--ink-2)",
        }}
      >
        Couldn't load that automation.
      </div>
    );
  }
  if (!data) {
    return (
      <div
        style={{
          padding: "22px 28px",
          fontSize: "var(--text-body)",
          color: "var(--ink-3)",
        }}
      >
        Loading…
      </div>
    );
  }
  return (
    <AutomationEditor
      initialName={data.name}
      initialGraph={data.graph}
      workflowKey={data.workflowKey}
    />
  );
}
