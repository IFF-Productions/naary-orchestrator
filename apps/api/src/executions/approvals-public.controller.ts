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
import { ApiOkResponse, ApiProperty, ApiResponse } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString } from "class-validator";
import { Public } from "../auth/public.decorator";
import { verifyApprovalToken } from "./approval-token";
import { ExecutionsService } from "./executions.service";

export class DecideDto {
  @ApiProperty({ description: "The signed link token." })
  @IsString()
  token!: string;

  @ApiProperty({ enum: ["approve", "reject"] })
  @IsIn(["approve", "reject"])
  decision!: "approve" | "reject";

  @ApiProperty({ required: false, description: "Optional reason." })
  @IsOptional()
  @IsString()
  comment?: string;
}

/** The prompt shown on the public decision page — only the node's title/instructions,
 *  no tenant identifiers. `awaiting: false` if the run already decided / closed. */
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
}

/** The outcome of a public signed-link decision. */
export class DecideResultResponse {
  @ApiProperty({ enum: ["approved", "rejected"], example: "approved" })
  status!: string;
}

/**
 * PUBLIC approval decision via a signed link (the notification-links gap). Both routes are
 * authenticated by the HMAC token over the workflowId (the link IS the credential), NOT a bearer —
 * so a recipient of the pause notification can approve/reject WITHOUT opening the app. Mirrors the
 * webhook-resume ingress. Backs the public /approve/:workflowId decision page.
 */
@Public()
@Controller("approvals")
export class ApprovalsPublicController {
  constructor(private readonly executions: ExecutionsService) {}

  /** The prompt for the decision page (verified by token). `awaiting: false` if the run already
   *  decided / closed. Reveals only the node's title/instructions — no tenant identifiers. */
  @ApiOkResponse({ type: ApprovalPromptResponse })
  @Get(":workflowId")
  async prompt(
    @Param("workflowId") workflowId: string,
    @Query("token") token: string,
  ): Promise<ApprovalPromptResponse> {
    if (!verifyApprovalToken(workflowId, token)) {
      throw new UnauthorizedException("Invalid or missing approval token");
    }
    return this.executions.promptByWorkflowId(workflowId);
  }

  /** Approve or reject the run. 202 on success; 409 if it's no longer awaiting approval. */
  @ApiResponse({ status: 202, type: DecideResultResponse })
  @Post(":workflowId/decide")
  @HttpCode(202)
  async decide(
    @Param("workflowId") workflowId: string,
    @Body() body: DecideDto,
  ): Promise<DecideResultResponse> {
    if (!verifyApprovalToken(workflowId, body.token)) {
      throw new UnauthorizedException("Invalid or missing approval token");
    }
    const approved = body.decision === "approve";
    await this.executions.decideByToken(workflowId, approved, body.comment);
    return { status: approved ? "approved" : "rejected" };
  }
}
