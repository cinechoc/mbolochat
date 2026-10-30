import { IsEnum } from 'class-validator';

export class ResolveJoinRequestDto {
  @IsEnum(['approve', 'reject'], { message: 'action must be approve or reject' })
  action: 'approve' | 'reject';
}
