import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Profil modifiable via `PATCH /users/me`.
 *
 * Bornes alignées sur l'existant : `displayName` suit le plafond de la
 * création de compte (prénom + nom tronqués à 48 caractères,
 * `auth.service.ts`), `bio` suit la description de groupe (200,
 * `UpdateGroupDto`). Les champs ville/date de naissance restent décorés
 * pour que le contrôleur puisse les rejeter explicitement (400) au lieu de
 * les laisser effacer silencieusement par la whitelist du pipe global.
 */
export class UpdateMeDto {
  @IsOptional()
  @IsString({ message: 'Le nom doit être un texte.' })
  @MaxLength(48, { message: 'Le nom ne peut pas dépasser 48 caractères.' })
  displayName?: string;

  @IsOptional()
  @IsString({ message: 'La bio doit être un texte.' })
  @MaxLength(200, { message: 'La bio ne peut pas dépasser 200 caractères.' })
  bio?: string;

  @IsOptional()
  @IsBoolean({ message: 'notificationsEnabled doit être vrai ou faux.' })
  notificationsEnabled?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'notificationSound doit être vrai ou faux.' })
  notificationSound?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'notificationPreview doit être vrai ou faux.' })
  notificationPreview?: boolean;

  // Champs explicitement interdits sur cette route (voir le contrôleur) :
  // décorés pour ne pas être effacés par la whitelist avant le rejet 400.
  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  birthday?: string;

  @IsOptional()
  @IsString()
  cityUpdatedAt?: string;
}
