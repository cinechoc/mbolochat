import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { MessageEventsModule } from '../message-events/message-events.module.js';
import { MediaModule } from '../media/media.module.js';
import { PresenceModule } from '../presence/presence.module.js';
import { PushModule } from '../push/push.module.js';
import { UsersModule } from '../users/users.module.js';
import { ChatGateway } from './chat.gateway.js';
import { MessageEventsDispatcher } from './message-events.dispatcher.js';
import { SocketRateLimiter } from './socket-rate-limit.js';

@Module({
  imports: [
    ConversationsModule,
    MediaModule,
    MessageEventsModule,
    PresenceModule,
    PushModule,
    UsersModule,
  ],
  providers: [ChatGateway, MessageEventsDispatcher, SocketRateLimiter],
})
export class ChatModule {}
