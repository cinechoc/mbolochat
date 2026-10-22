import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module.js';
import { PushService } from './push.service.js';

@Module({
  imports: [MediaModule],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
