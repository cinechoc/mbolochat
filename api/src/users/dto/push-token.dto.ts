import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Enregistrement du jeton push (`POST /users/me/push-token`).
 *
 * Le jeton Expo (`ExponentPushToken[…]`) fait quelques dizaines de
 * caractères ; 512 est une marge large qui borne néanmoins la colonne
 * `text` illimitée de `push_tokens`. `platform` est restreint aux valeurs
 * que le client envoie (`android` par défaut, `ios`, `web`). `apiBaseUrl`
 * reste validée et normalisée dans le service.
 */
export class RegisterPushTokenDto {
  @IsString({ message: 'Le jeton push doit être un texte.' })
  @MinLength(1, { message: 'Le jeton push est requis.' })
  @MaxLength(512, { message: 'Le jeton push ne peut pas dépasser 512 caractères.' })
  token: string;

  @IsOptional()
  @IsIn(['android', 'ios', 'web'], { message: 'Plateforme push inconnue.' })
  platform?: string;

  @IsOptional()
  @IsString({ message: 'apiBaseUrl doit être un texte.' })
  @MaxLength(512, { message: 'apiBaseUrl ne peut pas dépasser 512 caractères.' })
  apiBaseUrl?: string;
}

/** Retrait du jeton push (`DELETE /users/me/push-token`) : même borne. */
export class RemovePushTokenDto {
  @IsOptional()
  @IsString({ message: 'Le jeton push doit être un texte.' })
  @MaxLength(512, { message: 'Le jeton push ne peut pas dépasser 512 caractères.' })
  token?: string;
}
