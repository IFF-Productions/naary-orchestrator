import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

/** Open a new builder session. All fields optional — an empty body starts a blank build in the
 *  active environment. */
export class OpenSessionDto {
  @ApiProperty({
    required: false,
    description:
      "Seed the working draft from this workflow's latest graph in the active environment.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  workflowKey?: string;

  @ApiProperty({
    required: false,
    description:
      "Short label for the resume list (defaults to the first prompt, Slice 2).",
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}

/** Close a session. `saved` = the draft was saved to a workflow; `done` = the user is finished. */
export class CloseSessionDto {
  @ApiProperty({ enum: ["saved", "done"], example: "done" })
  @IsIn(["saved", "done"])
  reason!: "saved" | "done";
}

/** Send a conversation turn — a natural-language change to apply to the working draft. */
export class SendTurnDto {
  @ApiProperty({
    example: "Add a Slack notification after the approval step.",
    description: "The change to apply, in plain language.",
  })
  @IsString()
  @MaxLength(4000)
  message!: string;

  @ApiProperty({
    required: false,
    description:
      "Model provider to generate with (anthropic|openai|google|claude-code). Defaults to the workspace's configured provider.",
  })
  @IsOptional()
  @IsString()
  provider?: string;

  /**
   * The draft this turn edits, when the CALLER holds it rather than the server.
   *
   * The session's `currentGraph` is seeded from the SAVED workflow row and rewritten by each
   * turn's result — which is the whole truth for the Build with AI screen, where the draft only
   * ever exists server-side. It is NOT the whole truth for the canvas panel: that panel is a strip
   * under the top bar, the canvas stays fully interactive beneath it, and the user can drag, add or
   * reconfigure a node BETWEEN turns. Seeding the session once at open time would go stale on the
   * first such edit, and the next turn would return a graph with the user's hand-edits quietly
   * removed — the "it rewrote my workflow" failure (#874) in a new place.
   *
   * So a caller that owns the draft sends it, and it wins for THIS turn. `currentGraph` keeps a
   * single meaning either way: the last validated draft the session produced, and the input to the
   * next turn for callers that don't supply one.
   */
  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    description:
      "The working draft to apply the change to. Present ⇒ it supersedes the session's stored " +
      "draft for this turn (the canvas panel owns its graph, including unsaved edits). Absent ⇒ " +
      "the session's `currentGraph` is edited, and an empty one makes this turn a create.",
  })
  @IsOptional()
  @IsObject()
  graph?: Record<string, unknown>;
}
