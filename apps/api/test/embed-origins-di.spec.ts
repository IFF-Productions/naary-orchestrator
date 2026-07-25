import "reflect-metadata";
// SecretStore (constructed by TurnstileConfigModule's useFactory) reads ENCRYPTION_KEY at
// construction — set it before the modules are imported/instantiated.
process.env.ENCRYPTION_KEY ??= "0".repeat(64);
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { EmbedOriginsModule } from "../src/common/embed-origins.module";
import { EmbedOriginsService } from "../src/common/embed-origins.service";
import { TurnstileConfigController } from "../src/turnstile/turnstile-config.controller";
import { TurnstileConfigModule } from "../src/turnstile/turnstile-config.module";

// #617 added EmbedOriginsService as a THIRD constructor dependency of TurnstileConfigController
// (to invalidate the shared allowlist's cache on write), provided by a @Global module that
// TurnstileConfigModule does not import explicitly. If that global registration were wrong, Nest
// would fail at boot with "Nest can't resolve dependencies of TurnstileConfigController (…, ?)" —
// which the service unit tests (plain `new`) cannot catch. Compiling the real modules can.
// Mirrors auth-guard-di.spec.ts.
describe("EmbedOrigins DI wiring (#617)", () => {
  it("resolves the controller's EmbedOriginsService across the @Global boundary", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EmbedOriginsModule, TurnstileConfigModule],
    }).compile();

    expect(moduleRef.get(TurnstileConfigController)).toBeInstanceOf(
      TurnstileConfigController,
    );
    // main.ts pulls the SAME instance out with app.get() to build the public CORS middleware,
    // so the cache the controller invalidates is the cache the middleware reads.
    expect(
      moduleRef.get(EmbedOriginsService, { strict: false }),
    ).toBeInstanceOf(EmbedOriginsService);
  });
});
