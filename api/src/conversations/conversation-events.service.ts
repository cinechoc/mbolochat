import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { MessageDto } from './conversations.service.js';

/** Ce qui a changé dans une conversation, à diffuser aux clients connectés. */
export type ConversationChange =
  | { kind: 'created'; conversationId: string; userIds: string[] }
  | { kind: 'updated'; conversationId: string; actorId: string }
  | {
      kind: 'members';
      conversationId: string;
      actorId: string;
      action: 'added' | 'removed' | 'left' | 'role';
      userIds: string[];
    }
  /** Message créé côté serveur (message système), à diffuser comme un envoi. */
  | { kind: 'message'; conversationId: string; actorId: string; message: MessageDto };

/**
 * Bus d'événements entre le service de conversations et la passerelle socket.
 *
 * Passer par un Subject évite au service de dépendre de la passerelle (et au
 * gateway de dépendre de son propre module) : le service publie après commit,
 * la passerelle traduit en événements temps réel.
 */
@Injectable()
export class ConversationEventsService {
  private readonly subject = new Subject<ConversationChange>();
  readonly changes$ = this.subject.asObservable();

  publish(change: ConversationChange): void {
    this.subject.next(change);
  }
}
