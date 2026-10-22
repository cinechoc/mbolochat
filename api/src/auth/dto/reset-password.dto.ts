import { IsString, Length, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString({ message: 'L’email ou le nom d’utilisateur doit être un texte.' })
  @MinLength(3, {
    message: 'L’email ou le nom d’utilisateur doit contenir au moins 3 caractères.',
  })
  emailOrUsername: string;

  @IsString({ message: 'Le code doit être un texte.' })
  @Length(6, 6, { message: 'Le code doit contenir exactement 6 chiffres.' })
  code: string;

  @IsString({ message: 'Le nouveau mot de passe doit être un texte.' })
  @MinLength(8, { message: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' })
  newPassword: string;
}
