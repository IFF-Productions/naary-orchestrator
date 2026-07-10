import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class RegisterChatDto {
  @ApiProperty({
    example: "support-chat",
    description: "The workflow (workflowKey) this chat starts per message.",
  })
  @IsString()
  @IsNotEmpty()
  workflowId!: string;
}
