import { Module } from "@nestjs/common";
import { FormAssetService } from "./form-asset.service";

/**
 * FormAssetService on its own, so BOTH the forms surface (upload + public serve) and GraphsService
 * (the save-time logo ownership check) can inject it.
 *
 * A dedicated module rather than exporting it from FormsModule: GraphsModule would then have to
 * import all of FormsModule — pulling in ExecutionsModule and ContentTemplatesModule purely to reach
 * one lookup — and FormsModule already depends on the globally-provided GraphsService, so the two
 * would point at each other. This keeps the dependency one-directional and one class wide.
 */
@Module({
  // useFactory, not a bare class: the constructor takes an `ObjectStore` (a TS INTERFACE) with a
  // default of `getObjectStore()`. Nest sees a parameter it can't resolve to a provider and throws
  // "can't resolve dependencies of the FormAssetService (?)" — the interface erases to `Object` in the
  // emitted metadata. Constructing it ourselves lets the default apply, and matches how GraphsModule
  // already provides the plain classes from @naary/secrets and @naary/connections.
  providers: [{ provide: FormAssetService, useFactory: () => new FormAssetService() }],
  exports: [FormAssetService],
})
export class FormAssetModule {}
