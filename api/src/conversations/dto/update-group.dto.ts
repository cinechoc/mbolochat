import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Champs d'identité modifiables d'un groupe ; tous facultatifs. */
export class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  emoji?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a #RRGGBB hex color' })
  color?: string;

  @IsOptional()
  @IsIn(['all', 'admins'], { message: 'whoCanSend must be all or admins' })
  whoCanSend?: 'all' | 'admins';

  @IsOptional()
  @IsIn(['all', 'admins'], { message: 'whoCanAdd must be all or admins' })
  whoCanAdd?: 'all' | 'admins';
}
