import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  imports: [UsersModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
