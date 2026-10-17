import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { ChatModule } from './chat/chat.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { DbModule } from './db/db.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    AuthModule,
    UsersModule,
    ConversationsModule,
    ChatModule,
  ],
})
export class AppModule {}
