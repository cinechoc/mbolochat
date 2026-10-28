import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { PresenceModule } from '../presence/presence.module.js';
import { PushModule } from '../push/push.module.js';
import { UsersModule } from '../users/users.module.js';
import { SocketRateLimiter } from '../chat/socket-rate-limit.js';
import { CallsGateway } from './calls.gateway.js';
import { CallsService } from './calls.service.js';

@Module({
  imports: [ConversationsModule, UsersModule, PushModule, PresenceModule],
  providers: [CallsService, CallsGateway, SocketRateLimiter],
  exports: [CallsService],
})
export class CallsModule {}
