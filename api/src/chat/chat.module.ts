import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { MediaModule } from '../media/media.module.js';
import { PushModule } from '../push/push.module.js';
import { ChatGateway } from './chat.gateway.js';

@Module({
  imports: [ConversationsModule, MediaModule, PushModule],
  providers: [ChatGateway],
})
export class ChatModule {}
