import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { InvitesController } from './invites.controller.js';
import { InvitesService } from './invites.service.js';
import { PublicInvitesController } from './public-invites.controller.js';

@Module({
  imports: [ConversationsModule],
  controllers: [InvitesController, PublicInvitesController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
