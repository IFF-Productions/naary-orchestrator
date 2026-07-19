import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

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
}
