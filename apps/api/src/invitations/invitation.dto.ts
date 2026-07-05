import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
} from "class-validator";

/** Create an invite. `owner` is never grantable via an invite (design Path B). */
export class CreateInvitationDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsIn(["admin", "member"])
  role?: string;
}

/** Accept an invite. The token rides in the BODY (never the URL) so it can't leak into
 *  request logs / the audit path before it's consumed. */
export class AcceptInvitationDto {
  @IsString()
  @MinLength(20)
  token!: string;
}
