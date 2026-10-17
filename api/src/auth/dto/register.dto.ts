import { IsDateString, IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export type Gender = 'FEMALE' | 'MALE' | 'CUSTOM';

export class RegisterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(24)
  firstName: string;

  @IsString()
  @MinLength(1)
  @MaxLength(24)
  lastName: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  @IsDateString({}, { message: 'birthday must be a valid ISO date (YYYY-MM-DD)' })
  birthday: string;

  @IsIn(['FEMALE', 'MALE', 'CUSTOM'], { message: 'gender must be FEMALE, MALE or CUSTOM' })
  gender: Gender;
}
