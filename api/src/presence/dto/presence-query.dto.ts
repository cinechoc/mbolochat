import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class PresenceQueryDto {
  @Transform(({ value }) =>
    typeof value === 'string'
      ? [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))]
      : value,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  ids: string[];
}
