import { loadConfig } from "./config";
import { createRunnerServer } from "./server";

const cfg = loadConfig(process.env);
createRunnerServer(cfg).listen(cfg.port, () => {
  // No secrets in the log — just that we're up + the isolation settings.
  console.log(
    // One image per tool since #680 — log the whole map so an operator can see at a glance which
    // image each `tool:` will launch (a mismatch here is the most likely misconfiguration).
    `[sandbox-runner] listening on :${cfg.port} · images=${Object.entries(
      cfg.images,
    )
      .map(([tool, image]) => `${tool}=${image}`)
      .join(" ")} · network=${cfg.network}`,
  );
});
