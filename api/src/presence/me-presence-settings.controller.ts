import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { UpdatePresenceSettingsDto } from './dto/update-presence-settings.dto.js';
import { PresenceService } from './presence.service.js';

@Controller('me/presence-settings')
@UseGuards(JwtAuthGuard)
export class MePresenceSettingsController {
  constructor(private readonly presence: PresenceService) {}

  @Get()
  get(@CurrentUser() current: JwtPayload) {
    return this.presence.getSettings(current.sub);
  }

  @Patch()
  update(@CurrentUser() current: JwtPayload, @Body() dto: UpdatePresenceSettingsDto) {
    return this.presence.updateSettings(current.sub, {
      lastSeenVisibility: dto.lastSeenVisibility,
      onlineVisibility: dto.onlineVisibility,
    });
  }
}
