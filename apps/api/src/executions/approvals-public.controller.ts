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
import { ApiProperty } from "@nestjs/swagger";
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
  @Get(":workflowId")
  async prompt(
    @Param("workflowId") workflowId: string,
    @Query("token") token: string,
  ) {
    if (!verifyApprovalToken(workflowId, token)) {
      throw new UnauthorizedException("Invalid or missing approval token");
    }
    return this.executions.promptByWorkflowId(workflowId);
  }

  /** Approve or reject the run. 202 on success; 409 if it's no longer awaiting approval. */
  @Post(":workflowId/decide")
  @HttpCode(202)
  async decide(
    @Param("workflowId") workflowId: string,
    @Body() body: DecideDto,
  ): Promise<{ status: string }> {
    if (!verifyApprovalToken(workflowId, body.token)) {
      throw new UnauthorizedException("Invalid or missing approval token");
    }
    const approved = body.decision === "approve";
    await this.executions.decideByToken(workflowId, approved, body.comment);
    return { status: approved ? "approved" : "rejected" };
  }
}
