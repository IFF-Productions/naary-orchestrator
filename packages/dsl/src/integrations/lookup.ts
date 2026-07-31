/**
 * The two catalog reads — provider by key, action by provider + key — that every other consumer
 * goes through.
 *
 * Its own file so `./build-request` and `./validate` depend on a lookup rather than on the
 * catalog literal, which keeps the dependency edges one-way: providers → catalog → lookup →
 * {build-request, validate} → the barrel. Nothing in that chain points back up, so a provider
 * file can never accidentally reach the request builder.
 */
import { INTEGRATION_CATALOG } from "./catalog";
import type { IntegrationAction, IntegrationProvider } from "./types";

export function getIntegrationProvider(
  provider: string,
): IntegrationProvider | undefined {
  return INTEGRATION_CATALOG[provider];
}

export function getIntegrationAction(
  provider: string,
  action: string,
): IntegrationAction | undefined {
  return INTEGRATION_CATALOG[provider]?.actions.find((a) => a.key === action);
}
