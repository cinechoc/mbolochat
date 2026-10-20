import { Module } from '@nestjs/common';
import { PushService } from './push.service.js';

@Module({
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
