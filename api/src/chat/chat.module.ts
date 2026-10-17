import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { ChatGateway } from './chat.gateway.js';

@Module({
  imports: [ConversationsModule],
  providers: [ChatGateway],
})
export class ChatModule {}
