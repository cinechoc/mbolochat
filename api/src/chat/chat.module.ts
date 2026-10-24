import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { MediaModule } from '../media/media.module.js';
import { PresenceModule } from '../presence/presence.module.js';
import { PushModule } from '../push/push.module.js';
import { ChatGateway } from './chat.gateway.js';
import { SocketRateLimiter } from './socket-rate-limit.js';

@Module({
  imports: [ConversationsModule, MediaModule, PresenceModule, PushModule],
  providers: [ChatGateway, SocketRateLimiter],
})
export class ChatModule {}
