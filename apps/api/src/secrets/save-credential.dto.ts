import { IsNotEmpty, IsString } from "class-validator";

export class SaveCredentialDto {
  @IsString()
  @IsNotEmpty()
  provider!: string;

  @IsString()
  @IsNotEmpty()
  apiKey!: string;
}
