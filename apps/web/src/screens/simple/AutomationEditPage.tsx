import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type NamedGraph } from "../../lib/api";
import { AutomationEditor } from "./AutomationEditor";

/**
 * Self-loading page for the `/app/automations/:key/edit` route — fetches the saved graph
 * then renders the beat-block editor. The list/detail routes stay friendly (a run view);
 * this is the explicit "Edit steps" destination. (Its own file so the lazy router import
 * sees only a zero-prop page component — AutomationEditor itself takes required props.)
 */
export function AutomationEditPage() {
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
