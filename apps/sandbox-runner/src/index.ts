import { loadConfig } from "./config";
import { createRunnerServer } from "./server";

const cfg = loadConfig(process.env);
createRunnerServer(cfg).listen(cfg.port, () => {
  // No secrets in the log — just that we're up + the isolation settings.
  console.log(
    `[sandbox-runner] listening on :${cfg.port} · image=${cfg.image} · network=${cfg.network}`,
  );
});
