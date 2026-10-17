import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { UsersService, toPublicUser } from './users.service.js';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async me(@CurrentUser() current: JwtPayload) {
    const user = await this.usersService.getByIdOrThrow(current.sub);
    return toPublicUser(user);
  }

  @Get('search')
  async search(@CurrentUser() current: JwtPayload, @Query('q') query?: string) {
    if (!query || query.trim().length === 0) {
      return [];
    }
    return this.usersService.search(query, current.sub);
  }
}
