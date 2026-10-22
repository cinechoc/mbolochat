import { IsDateString, IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export type Gender = 'FEMALE' | 'MALE' | 'CUSTOM';

export class RegisterDto {
  @IsString({ message: 'Le prénom doit être un texte.' })
  @MinLength(1, { message: 'Le prénom est requis.' })
  @MaxLength(24, { message: 'Le prénom ne peut pas dépasser 24 caractères.' })
  firstName: string;

  @IsString({ message: 'Le nom de famille doit être un texte.' })
  @MinLength(1, { message: 'Le nom de famille est requis.' })
  @MaxLength(24, { message: 'Le nom de famille ne peut pas dépasser 24 caractères.' })
  lastName: string;

  @IsEmail({}, { message: 'L’adresse e-mail n’est pas valide.' })
  email: string;

  @IsString({ message: 'Le mot de passe doit être un texte.' })
  @MinLength(8, { message: 'Le mot de passe doit contenir au moins 8 caractères.' })
  @MaxLength(72, { message: 'Le mot de passe ne peut pas dépasser 72 caractères.' })
  password: string;

  @IsDateString({}, { message: 'La date de naissance doit être une date valide.' })
  birthday: string;

  @IsIn(['FEMALE', 'MALE', 'CUSTOM'], { message: 'Choisis un genre valide.' })
  gender: Gender;
}
