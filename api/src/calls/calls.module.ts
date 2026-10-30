import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { MediaModule } from '../media/media.module.js';
import { PresenceModule } from '../presence/presence.module.js';
import { PushModule } from '../push/push.module.js';
import { UsersModule } from '../users/users.module.js';
import { SocketRateLimiter } from '../chat/socket-rate-limit.js';
import { CallsGateway } from './calls.gateway.js';
import { CallsService } from './calls.service.js';
import { CallLimits } from './call-limits.js';
import { GroupCallsService } from './group-calls.service.js';
import { IceServersController } from './ice-servers.controller.js';

@Module({
  imports: [ConversationsModule, UsersModule, PushModule, PresenceModule, MediaModule],
  controllers: [IceServersController],
  providers: [CallsService, GroupCallsService, CallLimits, CallsGateway, SocketRateLimiter],
  exports: [CallsService, GroupCallsService],
})
export class CallsModule {}
