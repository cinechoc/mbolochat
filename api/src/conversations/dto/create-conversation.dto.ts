import { ArrayNotEmpty, IsArray, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateConversationDto {
  @IsOptional()
  @IsEnum(['DIRECT', 'GROUP'], { message: 'type must be DIRECT or GROUP' })
  type?: 'DIRECT' | 'GROUP';

  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  memberIds: string[];
}
