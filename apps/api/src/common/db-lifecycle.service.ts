import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { disconnectPrisma } from "@naary/db";

/** Closes the pg pool when the app shuts down (enableShutdownHooks → onModuleDestroy). */
@Injectable()
export class DbLifecycleService implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await disconnectPrisma();
  }
}
