import { Module } from '@nestjs/common';
import { MessageEventsService } from './message-events.service.js';

/**
 * Journal des effets secondaires. Le module ne connaît ni Socket.IO ni le push :
 * il ne fait que garantir la persistance et l'unicité des lignes.
 */
@Module({
  providers: [MessageEventsService],
  exports: [MessageEventsService],
})
export class MessageEventsModule {}
