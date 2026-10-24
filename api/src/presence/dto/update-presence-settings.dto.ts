import { IsIn, IsOptional } from 'class-validator';

export class UpdatePresenceSettingsDto {
  @IsOptional()
  @IsIn(['everyone', 'contacts', 'nobody'])
  lastSeenVisibility?: 'everyone' | 'contacts' | 'nobody';

  @IsOptional()
  @IsIn(['everyone', 'same_as_last_seen'])
  onlineVisibility?: 'everyone' | 'same_as_last_seen';
}
