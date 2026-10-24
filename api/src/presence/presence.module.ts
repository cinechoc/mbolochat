import { Module } from '@nestjs/common';
import { MePresenceSettingsController } from './me-presence-settings.controller.js';
import { PresenceController } from './presence.controller.js';
import { PresenceService } from './presence.service.js';

@Module({
  controllers: [PresenceController, MePresenceSettingsController],
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
