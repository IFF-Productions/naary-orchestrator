import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ApiEndpoint } from "../swagger/api-decorators";
import { AddMemberDto } from "./member.dto";
import { MemberResponse } from "./member.response";
import { type MemberView, MembersService } from "./members.service";

/** tenantId comes from the path; the global AuthGuard enforces path-tenant ==
 *  token-tenant, so a caller can only manage their own workspace's members. */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/members")
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @ApiEndpoint({
    summary: "List workspace members",
    ok: [MemberResponse],
  })
  @Get()
  list(@Param("id") tenantId: string): Promise<MemberView[]> {
    return this.members.list(tenantId);
  }

  @ApiEndpoint({
    summary: "Add or update a member",
    description:
      "Upserts a member by (tenant, email); defaults role to 'member'.",
    created: MemberResponse,
  })
  @Post()
  add(
    @Param("id") tenantId: string,
    @Body() body: AddMemberDto,
  ): Promise<MemberView> {
    return this.members.add(tenantId, body.email, body.role ?? "member");
  }

  @ApiEndpoint({
    summary: "Remove a member",
    description: "Removes a member by id (204 No Content; no-op if unknown).",
  })
  @Delete(":memberId")
  @HttpCode(204)
  async remove(
    @Param("id") tenantId: string,
    @Param("memberId") memberId: string,
  ): Promise<void> {
    await this.members.remove(tenantId, memberId);
  }
}
