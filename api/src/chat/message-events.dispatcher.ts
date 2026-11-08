import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Server } from 'socket.io';
import {
  ConversationsService,
  type MessageDto,
} from '../conversations/conversations.service.js';
import { MessageEventsService } from '../message-events/message-events.service.js';
import type { MessageEvent } from '../db/schema.js';
import { MediaService } from '../media/media.service.js';
import { PushService } from '../push/push.service.js';
import { userRoomOf } from './socket-auth.js';

const roomOf = (conversationId: string) => `conv:${conversationId}`;

/**
 * Fréquence de reprise : rattrape un redémarrage ou un envoi manqué.
 * Réglable pour les tests e2e, où plusieurs instances partagent la même base.
 */
const SWEEP_INTERVAL_MS = Number(process.env.MESSAGE_EVENTS_SWEEP_MS ?? 5_000);
/** Lignes traitées par passe, pour ne pas monopoliser la boucle d'événements. */
const BATCH_LIMIT = 20;
/** Passe maximale par appel, pour borner le travail d'une requête d'envoi. */
const MAX_BATCHES = 5;
/** Ménage des lignes closes : au plus une fois par heure. */
const PURGE_INTERVAL_MS = 60 * 60_000;
/** Durée de conservation du journal (le message, lui, reste). */
const PURGE_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * Exécute le journal des effets secondaires : diffuse `message:new`, calcule
 * les destinataires, envoie les notifications.
 *
 * Le worker est **le seul** à émettre pour un message : le gateway ne fait plus
 * qu'appeler `deliverMessage` après la création. Une ligne déjà `done` n'est
 * jamais reprise, donc une requête répétée ne rediffuse ni ne renotifie.
 */
@Injectable()
export class MessageEventsDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageEventsDispatcher.name);
  private server?: Server;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private lastPurge = 0;

  constructor(
    private readonly events: MessageEventsService,
    private readonly conversations: ConversationsService,
    private readonly push: PushService,
    private readonly media: MediaService,
  ) {}

  onModuleInit(): void {
    // Un dépôt hors du chemin d'envoi (message système, avis d'appel) réveille
    // la reprise sans attendre le prochain tour.
    this.events.onPending = () => {
      void this.sweep();
    };
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    // Le minuteur ne doit pas retenir le processus (arrêt, tests).
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.events.onPending = null;
  }

  /**
   * Le serveur temps réel n'existe qu'une fois la passerelle initialisée.
   *
   * Aucune passe n'est déclenchée ici : la reprise de démarrage est le premier
   * tour de l'intervalle (au plus `SWEEP_INTERVAL_MS`), et le dépôt d'un effet
   * réveille le worker. Une passe implicite non attendue rendrait l'ordre des
   * diffusions imprévisible.
   */
  attachServer(server: Server): void {
    this.server = server;
  }

  /**
   * Chemin nominal, appelé par le gateway juste après la création : la
   * diffusion est attendue (l'acquittement la suit), les push partent ensuite
   * sans être attendus, comme avant.
   */
  async deliverMessage(messageId: string): Promise<void> {
    await this.process(messageId, { awaitPush: false });
  }

  /** Reprise : tout ce qui est en attente, tous messages confondus. */
  async sweep(): Promise<void> {
    if (this.sweeping || !this.server) {
      return;
    }
    this.sweeping = true;
    try {
      if (Date.now() - this.lastPurge > PURGE_INTERVAL_MS) {
        this.lastPurge = Date.now();
        await this.events.purgeFinished(PURGE_AGE_MS);
      }
      await this.process(undefined, { awaitPush: true });
    } catch (error) {
      this.logger.warn(
        `Reprise des effets impossible: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  private async process(
    messageId: string | undefined,
    options: { awaitPush: boolean },
  ): Promise<void> {
    const payloads = new Map<string, MessageDto>();
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await this.events.dueRows(BATCH_LIMIT, messageId);
      if (rows.length === 0) {
        return;
      }
      for (const row of rows) {
        const pushed = await this.handle(row, payloads, options.awaitPush);
        if (pushed === 'blocked') {
          return;
        }
      }
      // Pas de sortie après la première passe : le fan-out vient de créer les
      // lignes de push, il faut les traiter dans la même livraison.
    }
  }

  /**
   * Traite une ligne. `blocked` signifie « pas de serveur temps réel » : on
   * relâche le bail et on s'arrête sans consommer de tentative.
   */
  private async handle(
    row: MessageEvent,
    payloads: Map<string, MessageDto>,
    awaitPush: boolean,
  ): Promise<'done' | 'blocked'> {
    const claimed = await this.events.claim(row.id);
    if (!claimed) {
      // Un autre worker l'a prise entre la lecture et le bail.
      return 'done';
    }
    // Jeton de propriété de cette tentative : toute clôture le vérifie, donc
    // si le bail expire pendant l'envoi, ce worker ne peut plus rien écrire.
    const token = claimed.claimToken;
    if (!token) {
      return 'done';
    }
    if (!this.server) {
      if (!(await this.events.release(claimed.id, token))) {
        this.noteFenced(claimed, 'relâchement du bail');
      }
      return 'blocked';
    }
    try {
      if (claimed.kind === 'socket') {
        const message = await this.payloadOf(claimed.messageId, payloads);
        if (!message) {
          await this.close(claimed, token, 'message introuvable');
          return 'done';
        }
        // Mêmes salons qu'avant : conversation ouverte + salon personnel de
        // chaque membre. Socket.IO ne livre qu'une fois par socket.
        const memberIds = await this.conversations.listMemberIds(claimed.conversationId);
        this.server
          .to([roomOf(claimed.conversationId), ...memberIds.map((id) => userRoomOf(id))])
          .emit('message:new', this.media.signMessage(message));
        await this.close(claimed, token);
        return 'done';
      }

      if (claimed.kind === 'push_fanout') {
        // Ligne d'un ancien modèle (destinataires calculés au dispatch) : on ne
        // la rejoue pas, l'audience est désormais gelée à la création.
        await this.close(claimed, token, 'modèle de fan-out remplacé');
        return 'done';
      }

      const message = await this.payloadOf(claimed.messageId, payloads);
      if (!message) {
        await this.close(claimed, token, 'message introuvable');
        return 'done';
      }
      const deliver = this.push.notifyForUser(message, claimed.userId);
      // `false` = rien à envoyer : membre retiré depuis l'envoi, notifications
      // coupées, conversation en sourdine, ou plus de jeton push. La ligne est
      // close en `skipped`, pas en `done` : la raison reste lisible.
      const settle = async (sent: boolean) => {
        await this.close(
          claimed,
          token,
          sent ? null : 'destinataire hors audience ou préférences',
        );
      };
      if (awaitPush) {
        // Reprise : l'ordre compte peu, mais la ligne n'est close qu'après
        // l'envoi, pour qu'un échec soit rejoué.
        await settle(await deliver);
        return 'done';
      }
      // Chemin nominal : l'acquittement du message ne doit pas attendre le
      // fournisseur. La ligne est close (ou reportée) à la fin de l'envoi.
      void deliver
        .then(settle)
        .catch((error: unknown) => this.report(claimed, token, describe(error)));
      return 'done';
    } catch (error) {
      await this.report(claimed, token, describe(error));
      return 'done';
    }
  }

  /** Clôt en `done` ; un refus signifie que le bail est passé à un autre. */
  private async close(row: MessageEvent, token: string, reason: string | null = null) {
    if (!(await this.events.markDone(row.id, token, reason))) {
      this.noteFenced(row, 'clôture');
      return false;
    }
    return true;
  }

  /** Reporte ou abandonne une tentative en échec, sous la même garde. */
  private async report(row: MessageEvent, token: string, error: string) {
    if (!(await this.events.reschedule(row, token, error))) {
      this.noteFenced(row, 'report');
    }
  }

  private noteFenced(row: MessageEvent, operation: string) {
    this.logger.warn(
      `Bail perdu pendant la ${operation} de l'effet ${row.kind} du message ${row.messageId} : ` +
        `un autre worker l'a repris, action ignorée`,
    );
  }

  /** Le DTO est reconstruit depuis la base : rien de signé n'est stocké. */
  private async payloadOf(
    messageId: string,
    cache: Map<string, MessageDto>,
  ): Promise<MessageDto | undefined> {
    const cached = cache.get(messageId);
    if (cached) {
      return cached;
    }
    try {
      const dto = await this.conversations.messageDto(messageId);
      cache.set(messageId, dto);
      return dto;
    } catch (error) {
      // Message disparu (conversation supprimée entre-temps) : inutile de
      // réessayer cinq fois, la ligne sera abandonnée par l'appelant.
      if (error instanceof NotFoundException) {
        return undefined;
      }
      throw error;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
