import { IsBoolean, IsOptional } from 'class-validator';

export class UpdatePreferencesDto {
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsBoolean()
  muted?: boolean;

  @IsOptional()
  @IsBoolean()
  hidden?: boolean;
}
