import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

/** Generate a draft graph from a plain-English description (AI workflow builder).
 *  Bounded length keeps the model prompt sane and blocks abuse. */
export class GenerateGraphDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  prompt!: string;

  /** Optional model provider to generate with (anthropic | openai | google). Omitted ⇒
   *  the generator picks the tenant's first configured+valid provider. */
  @IsOptional()
  @IsString()
  provider?: string;
}

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
