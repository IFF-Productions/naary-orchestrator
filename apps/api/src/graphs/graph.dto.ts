import { IsObject, IsString } from "class-validator";

/** Save a graph for a tenant under a stable workflowKey. The `graph` is validated
 *  in depth by `validateGraph` inside GraphsService.upsert (400 on a bad graph);
 *  here we only assert it's an object — the controller checks the top-level shape. */
export class SaveGraphDto {
  @IsString()
  workflowKey!: string;

  @IsString()
  name!: string;

  @IsObject()
  graph!: Record<string, unknown>;
}
