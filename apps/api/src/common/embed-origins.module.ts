import { Global, Module } from "@nestjs/common";
import { EmbedOriginsService } from "./embed-origins.service";

/**
 * Provides the per-tenant embed-origin resolver (#617). @Global so both `main.ts` (which pulls it
 * out with `app.get()` to build the express-level public CORS middleware) and the Turnstile config
 * controller (which invalidates its cache after a write) share ONE instance — and therefore one
 * cache.
 */
@Global()
@Module({
  providers: [EmbedOriginsService],
  exports: [EmbedOriginsService],
})
export class EmbedOriginsModule {}
