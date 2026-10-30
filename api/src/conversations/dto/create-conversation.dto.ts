import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateConversationDto {
  @IsOptional()
  @IsEnum(['DIRECT', 'GROUP'], { message: 'type must be DIRECT or GROUP' })
  type?: 'DIRECT' | 'GROUP';

  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  emoji?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a #RRGGBB hex color' })
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @IsOptional()
  @IsIn(['all', 'admins'], { message: 'whoCanSend must be all or admins' })
  whoCanSend?: 'all' | 'admins';

  @IsOptional()
  @IsIn(['all', 'admins'], { message: 'whoCanAdd must be all or admins' })
  whoCanAdd?: 'all' | 'admins';

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  memberIds: string[];
}
