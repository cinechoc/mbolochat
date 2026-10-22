import { IsString, MinLength } from 'class-validator';

export class ForgotPasswordDto {
  @IsString({ message: 'L’email ou le nom d’utilisateur doit être un texte.' })
  @MinLength(3, {
    message: 'L’email ou le nom d’utilisateur doit contenir au moins 3 caractères.',
  })
  emailOrUsername: string;
}
