import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

/** Generate a draft graph from a plain-English description (AI workflow builder).
 *  Bounded length keeps the model prompt sane and blocks abuse.
 *
 *  With `previous` the SAME route becomes an EDIT: `prompt` is then a change to apply to
 *  that graph rather than a description of a workflow to invent. The canvas needs this
 *  because a builder session (the other edit path) seeds from the SAVED row and would
 *  silently discard unsaved canvas work. */
export class GenerateGraphDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 2000,
    example:
      "When a webhook arrives, have an agent summarize it, wait for my approval, then email the summary.",
    description:
      "Plain-English description of the workflow to build — or, with `previous`, the change to apply to it.",
  })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  prompt!: string;

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    description:
      "The graph to CHANGE. Present ⇒ `prompt` is an edit instruction and the response is the " +
      "full updated graph with everything the change didn't touch left as-is. Absent ⇒ a new " +
      "workflow is invented from `prompt`. Must be a valid graph (400 otherwise).",
  })
  @IsOptional()
  @IsObject()
  previous?: Record<string, unknown>;

  @ApiPropertyOptional({
    enum: ["anthropic", "openai", "google", "claude-code"],
    description:
      "Provider to generate with. Omitted ⇒ the tenant's first configured+valid model provider, falling back to the Claude Code credential (subscription-billed, via the headless CLI).",
  })
  @IsOptional()
  @IsString()
  provider?: string;
}

/**
 * Import an n8n workflow JSON export (#579).
 *
 * The export goes in as an OBJECT, not a string: it is the JSON the user downloaded from n8n or
 * copied out of its editor, and the client parses it before posting so a syntax error is caught in
 * the browser rather than as an opaque 400. Nothing about it is trusted — `parseN8nWorkflow` reads
 * only the fields it recognises and guards against prototype-polluting keys.
 */
export class ImportN8nDto {
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description:
      "The n8n workflow export: `{ name, nodes: [...], connections: {...} }`. Credentials in it " +
      "are IGNORED — the response reports which connection types to create instead.",
  })
  @IsObject()
  workflow!: Record<string, unknown>;
}

/** Save a graph for a tenant under a stable workflowKey. The `graph` is validated
 *  in depth by `validateGraph` inside GraphsService.upsert (400 on a bad graph);
 *  here we only assert it's an object — the controller checks the top-level shape. */
export class SaveGraphDto {
  @ApiProperty({
    example: "support-triage",
    description: "Stable key the workflow is stored + run under.",
  })
  @IsString()
  workflowKey!: string;

  @ApiProperty({ example: "Support triage" })
  @IsString()
  name!: string;

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "The graph: { nodes, edges, startNodeId }.",
  })
  @IsObject()
  graph!: Record<string, unknown>;

  @ApiPropertyOptional({
    example: "Add retry to the HTTP node",
    description:
      "Optional commit note recorded on this version (#488, shown in version history).",
  })
  @IsOptional()
  @IsString()
  @MaxLength(280)
  message?: string;
}

/** Promote a workflow's definition from the ACTIVE env (X-Environment-Id) to a target env. */
export class PromoteGraphDto {
  @ApiProperty({
    example: "prod",
    description: "Target environment id or slug to promote INTO.",
  })
  @IsString()
  toEnv!: string;

  @ApiPropertyOptional({
    example: 3,
    description:
      "Source version to promote (default: the source env's latest version).",
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  fromVersion?: number;
}
