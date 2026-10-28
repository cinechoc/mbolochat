import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module.js';
import { CallsModule } from './calls/calls.module.js';
import { ChatModule } from './chat/chat.module.js';
import { AppThrottlerGuard } from './common/app-throttler.guard.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { DbModule } from './db/db.module.js';
import { MediaModule } from './media/media.module.js';
import { PresenceModule } from './presence/presence.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Garde-fou général : l'API n'a vocation à être appelée ni par un script de
    // force brute, ni par un client qui recharge sans cesse. Les routes
    // sensibles resserrent ce plafond elles-mêmes.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 200,
        // Les suites de tests enchaînent les appels depuis la même adresse ; le
        // garde-fou est vérifié pour de vrai par scripts/security-smoke.mjs, qui
        // tourne contre le serveur tel qu'il est servi.
        skipIf: () => process.env.NODE_ENV === 'test',
      },
    ]),
    DbModule,
    AuthModule,
    UsersModule,
    ConversationsModule,
    UploadsModule,
    MediaModule,
    PresenceModule,
    ChatModule,
    CallsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class AppModule {}
