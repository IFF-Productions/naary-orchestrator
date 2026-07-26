import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsString } from "class-validator";
import { INTEGRATION_PROVIDERS } from "@naary/dsl";

/** Every catalog provider key, for the DTO's `@IsIn` and the OpenAPI enum. Derived from the
 *  catalog so a new provider is testable the moment its entry lands — no second list to update. */
const PROVIDER_KEYS: string[] = INTEGRATION_PROVIDERS.map((p) => p.key);

/**
 * Body of `POST /tenants/:id/connections/:connectionId/test` (#701).
 *
 * `provider` is REQUIRED. A `Connection` row deliberately has no provider column — `type: "custom"`
 * is provider-agnostic and the catalog provider is chosen at the `integration` NODE — so only the
 * caller knows which API this token is for. There is intentionally NO `action` or `fields` here:
 * the action is derived from the catalog (cheapest non-write, zero-required-field read) so this
 * route cannot be talked into performing a write.
 */
export class TestConnectionDto {
  @ApiProperty({
    enum: PROVIDER_KEYS,
    example: "calendly",
    description:
      "Catalog provider to test this connection against (the same `provider` an `integration` " +
      "node would use).",
  })
  @IsString()
  @IsIn(PROVIDER_KEYS)
  provider!: string;
}
