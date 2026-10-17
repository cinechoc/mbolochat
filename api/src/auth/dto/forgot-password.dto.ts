import { IsString, MinLength } from 'class-validator';

export class ForgotPasswordDto {
  @IsString()
  @MinLength(3)
  emailOrUsername: string;
}
