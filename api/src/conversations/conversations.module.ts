import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module.js';
import { UsersModule } from '../users/users.module.js';
import { ConversationsController } from './conversations.controller.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  imports: [UsersModule, UploadsModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
