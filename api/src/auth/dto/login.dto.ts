import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsString({ message: 'L’email ou le nom d’utilisateur doit être un texte.' })
  @MinLength(3, {
    message: 'L’email ou le nom d’utilisateur doit contenir au moins 3 caractères.',
  })
  emailOrUsername: string;

  @IsString({ message: 'Le mot de passe doit être un texte.' })
  @MinLength(8, { message: 'Le mot de passe doit contenir au moins 8 caractères.' })
  password: string;
}
