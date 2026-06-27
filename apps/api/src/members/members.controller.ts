import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import { AddMemberDto } from "./member.dto";
import { type MemberView, MembersService } from "./members.service";

/** tenantId comes from the path; the global AuthGuard enforces path-tenant ==
 *  token-tenant, so a caller can only manage their own workspace's members. */
@Controller("tenants/:id/members")
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  list(@Param("id") tenantId: string): Promise<MemberView[]> {
    return this.members.list(tenantId);
  }

  @Post()
  add(
    @Param("id") tenantId: string,
    @Body() body: AddMemberDto,
  ): Promise<MemberView> {
    return this.members.add(tenantId, body.email, body.role ?? "member");
  }

  @Delete(":memberId")
  @HttpCode(204)
  async remove(
    @Param("id") tenantId: string,
    @Param("memberId") memberId: string,
  ): Promise<void> {
    await this.members.remove(tenantId, memberId);
  }
}
