import "reflect-metadata";
// ConnectionService (built by ConnectionsModule's useFactory) constructs a SecretStore, which reads
// ENCRYPTION_KEY at construction — set it before the module is imported/instantiated.
process.env.ENCRYPTION_KEY ??= "0".repeat(64);
import { ConnectionService } from "@naary/connections";
import { describe, expect, it } from "vitest";
import { EnvironmentsService } from "../src/environments/environments.service";
import { GraphsService } from "../src/graphs/graphs.service";
import { ConnectionTestService } from "../src/connections/connection-test.service";
import { ConnectionsController } from "../src/connections/connections.controller";
import { ConnectionsModule } from "../src/connections/connections.module";

/**
 * #701 added ConnectionTestService as a FOURTH constructor dependency of ConnectionsController. If
 * it were not registered in ConnectionsModule's providers, Nest would fail at BOOT with "Nest can't
 * resolve dependencies of ConnectionsController (…, …, …, ?)" — a 502 on *every* route, and
 * something the service's own unit tests (plain `new`) cannot catch because they never go via DI.
 *
 * Asserted against the emitted metadata rather than by compiling the module: ConnectionsController
 * also depends on GraphsService, which comes from the @Global GraphsModule, whose own transitive
 * imports (SchedulesModule → PermissionsModule → …) reach most of the app. Pinning the metadata
 * targets exactly the failure mode a new dependency introduces, with none of that surface.
 */
describe("Connections DI wiring (#701)", () => {
  it("every ConnectionsController dependency is provided by ConnectionsModule (or a @Global one)", () => {
    const params = (Reflect.getMetadata(
      "design:paramtypes",
      ConnectionsController,
      // biome-ignore lint/suspicious/noExplicitAny: reflect metadata is untyped by nature
    ) ?? []) as any[];
    // Metadata emitted at all — if swc dropped it, Nest resolves nothing (see di-wiring.spec.ts).
    expect(params.length).toBe(4);
    expect(params).toContain(ConnectionTestService);

    const providers = (Reflect.getMetadata("providers", ConnectionsModule) ??
      // biome-ignore lint/suspicious/noExplicitAny: reflect metadata is untyped by nature
      []) as any[];
    const providedTokens = new Set(
      providers.map((p) =>
        typeof p === "object" && p?.provide ? p.provide : p,
      ),
    );
    expect(providedTokens.has(ConnectionTestService)).toBe(true);
    expect(providedTokens.has(ConnectionService)).toBe(true);

    // The two that legitimately come from elsewhere: EnvironmentsService via the explicitly
    // imported EnvironmentsModule, GraphsService via the @Global GraphsModule.
    const imports = (Reflect.getMetadata("imports", ConnectionsModule) ??
      // biome-ignore lint/suspicious/noExplicitAny: reflect metadata is untyped by nature
      []) as any[];
    expect(imports.length).toBeGreaterThan(0);
    for (const dep of params) {
      const external = dep === EnvironmentsService || dep === GraphsService;
      expect(providedTokens.has(dep) || external).toBe(true);
    }
  });

  it("ConnectionTestService takes exactly the ConnectionService it is given", () => {
    // Its only injected dependency — the seam the unit spec substitutes. A second one added here
    // without registering it would be the same boot failure one level down.
    const params = (Reflect.getMetadata(
      "design:paramtypes",
      ConnectionTestService,
      // biome-ignore lint/suspicious/noExplicitAny: reflect metadata is untyped by nature
    ) ?? []) as any[];
    expect(params).toEqual([ConnectionService]);
  });
});
