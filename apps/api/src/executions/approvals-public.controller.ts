import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
} from "@nestjs/swagger";
import { IsIn, IsOptional, IsString } from "class-validator";
import { Public } from "../auth/public.decorator";
import { verifyApprovalToken } from "./approval-token";
import { ExecutionsService } from "./executions.service";

export class DecideDto {
  @ApiProperty({ description: "The signed link token." })
  @IsString()
  token!: string;

  @ApiProperty({
    required: false,
    description:
      "The link's `exp` claim (unix seconds), when the link carried one. Signed into the token — required to verify an expiring link.",
  })
  @IsOptional()
  @IsString()
  exp?: string;

  @ApiProperty({ enum: ["approve", "reject"] })
  @IsIn(["approve", "reject"])
  decision!: "approve" | "reject";

  @ApiProperty({ required: false, description: "Optional reason." })
  @IsOptional()
  @IsString()
  comment?: string;
}

/** The prompt shown on the public decision page — the node's title/instructions plus (Slice 1)
 *  the workspace display name, the pause-time context fields, and the link's expiry — no other
 *  tenant identifiers. `awaiting: false` if the run already decided / closed. */
export class ApprovalPromptResponse {
  @ApiProperty({
    example: true,
    description: "Whether the run is still awaiting a decision.",
  })
  awaiting!: boolean;
  @ApiProperty({ required: false, example: "Approve the drafted summary" })
  title?: string;
  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: "Review the summary before it is emailed.",
  })
  instructions?: string | null;
  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example: "Acme Inc",
    description:
      "Workspace display name — the page's trust line (on behalf of …). Null when unset.",
  })
  workspaceName?: string | null;
  // ApiPropertyOptional: with a raw `type: "object"` schema, ApiProperty's `required`
  // takes the SchemaObject overload (a string[] of required keys), not a boolean.
  @ApiPropertyOptional({
    type: "object",
    additionalProperties: { type: "string" },
    nullable: true,
    description:
      "Structured context card — expressions resolved at pause time (never secrets).",
  })
  contextFields?: Record<string, string> | null;
  @ApiProperty({ type: Number, required: false, nullable: true, example: 48 })
  slaHours?: number | null;
  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    format: "date-time",
    description: "pausedAt + slaHours (server-derived).",
  })
  dueAt?: string | null;
  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    format: "date-time",
    description:
      "When this signed link expires (its `exp` claim). Null for legacy links minted without one.",
  })
  expiresAt?: string | null;
}

/** The outcome of a public signed-link decision. */
export class DecideResultResponse {
  @ApiProperty({ enum: ["approved", "rejected"], example: "approved" })
  status!: string;
}

/** ISO expiry from a verified link's `exp` claim (unix seconds); null for legacy links. */
function expiresAtFrom(exp: string | undefined): string | null {
  if (!exp) return null;
  const n = Number(exp);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
}

/**
 * PUBLIC approval decision via a signed link (the notification-links gap). Both routes are
 * authenticated by the HMAC token over the workflowId (the link IS the credential), NOT a bearer —
 * so a recipient of the pause notification can approve/reject WITHOUT opening the app. Mirrors the
 * webhook-resume ingress. Backs the public /approve/:workflowId decision page.
 *
 * Links minted from Slice 1 on carry an `exp` claim signed into the token (see approval-token.ts);
 * the claim rides the URL/body and MUST be passed back for such links to verify. Legacy links
 * (no `exp`) still verify with the old formula and never expire.
 */
@Public()
@Controller("approvals")
export class ApprovalsPublicController {
  constructor(private readonly executions: ExecutionsService) {}

  /** The prompt for the decision page (verified by token). `awaiting: false` if the run already
   *  decided / closed. Reveals the node's prompt, workspace display name, context fields, and
   *  the link's expiry — no other tenant identifiers. */
  @ApiOkResponse({ type: ApprovalPromptResponse })
  // OPTIONAL: legacy links carry no exp claim — without this the generated clients would
  // be forced to always send one.
  @ApiQuery({ name: "exp", required: false, type: String })
  @Get(":workflowId")
  async prompt(
    @Param("workflowId") workflowId: string,
    @Query("token") token: string,
    @Query("exp") exp?: string,
  ): Promise<ApprovalPromptResponse> {
    if (!verifyApprovalToken(workflowId, token, exp)) {
      throw new UnauthorizedException(
        "Invalid, expired, or missing approval token",
      );
    }
    const prompt = await this.executions.promptByWorkflowId(workflowId);
    return { ...prompt, expiresAt: expiresAtFrom(exp) };
  }

  /** Approve or reject the run. 202 on success; 409 if it's no longer awaiting approval. */
  @ApiResponse({ status: 202, type: DecideResultResponse })
  @Post(":workflowId/decide")
  @HttpCode(202)
  async decide(
    @Param("workflowId") workflowId: string,
    @Body() body: DecideDto,
  ): Promise<DecideResultResponse> {
    if (!verifyApprovalToken(workflowId, body.token, body.exp)) {
      throw new UnauthorizedException(
        "Invalid, expired, or missing approval token",
      );
    }
    const approved = body.decision === "approve";
    await this.executions.decideByToken(workflowId, approved, body.comment);
    return { status: approved ? "approved" : "rejected" };
  }
}
