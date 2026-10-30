import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Durées proposées dans l'UI : 1 h, 24 h, 7 jours, 30 jours. */
export const INVITE_EXPIRY_HOURS = [1, 24, 168, 720] as const;

export class CreateInviteDto {
  @IsOptional()
  @IsIn(INVITE_EXPIRY_HOURS, { message: 'expiresInHours must be 1, 24, 168 or 720' })
  expiresInHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxUses?: number;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;
}
