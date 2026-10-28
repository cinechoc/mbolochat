import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { PresenceModule } from '../presence/presence.module.js';
import { PushService } from './push.service.js';

@Module({
  imports: [MediaModule, PresenceModule],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
