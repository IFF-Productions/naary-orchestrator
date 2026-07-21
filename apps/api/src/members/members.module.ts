import { Module } from "@nestjs/common";
import { MailerService } from "../mail/mailer.service";
import { MembersController } from "./members.controller";
import { MembersService } from "./members.service";

@Module({
  controllers: [MembersController],
  providers: [MembersService, MailerService],
})
export class MembersModule {}
