import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module.js';
import { UsersModule } from '../users/users.module.js';
import { ConversationEventsService } from './conversation-events.service.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  imports: [UsersModule, UploadsModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationEventsService],
  exports: [ConversationsService, ConversationEventsService],
})
export class ConversationsModule {}
