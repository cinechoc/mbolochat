import { IsEnum } from 'class-validator';

export class UpdateMemberRoleDto {
  @IsEnum(['admin', 'member'], { message: 'role must be admin or member' })
  role: 'admin' | 'member';
}
