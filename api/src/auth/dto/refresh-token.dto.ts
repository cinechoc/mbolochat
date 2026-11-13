import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Jeton de rafraîchissement (`POST /auth/refresh`, `POST /auth/logout`).
 *
 * Le jeton est opaque (chaîne aléatoire) ; seul un plafond de longueur est
 * imposé ici. L'absence du champ reste traitée par le service (401 pour le
 * rafraîchissement, no-op pour la déconnexion) : le DTO ne change ni les
 * réponses attendues ni la logique de rotation/révocation.
 */
export class RefreshTokenDto {
  @IsOptional()
  @IsString({ message: 'Le jeton de rafraîchissement doit être un texte.' })
  @MaxLength(512, { message: 'Le jeton de rafraîchissement ne peut pas dépasser 512 caractères.' })
  refreshToken?: string;
}
