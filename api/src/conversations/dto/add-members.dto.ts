import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

/**
 * Ajout de membres à une conversation (`POST /conversations/:id/members`).
 *
 * Les identifiants sont des UUID générés côté serveur (`crypto.randomUUID()`
 * dans `schema.ts`), mais le DTO ne impose pas le format UUID : il borne
 * la longueur de chaque identifiant (36 caractères pour un UUID) et la
 * taille du tableau (100, plafond de membres d'un groupe,
 * `MAX_GROUP_MEMBERS`). L'existence et les permissions restent vérifiées
 * dans le service (`addMembers`).
 */
export class AddMembersDto {
  @IsArray({ message: 'memberIds doit être un tableau.' })
  @ArrayMaxSize(100, { message: 'Trop d’identifiants dans memberIds.' })
  @IsString({ each: true, message: 'Chaque identifiant doit être un texte.' })
  @MaxLength(36, { each: true, message: 'Identifiant trop long dans memberIds.' })
  memberIds: string[];
}
