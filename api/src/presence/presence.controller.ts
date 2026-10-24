import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { PresenceQueryDto } from './dto/presence-query.dto.js';
import { PresenceService } from './presence.service.js';

@Controller('presence')
@UseGuards(JwtAuthGuard)
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  get(@CurrentUser() current: JwtPayload, @Query() query: PresenceQueryDto) {
    return this.presence.getPresenceForViewer(current.sub, query.ids);
  }
}
