import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/db.module.js';
import { messageEvents, type MessageEvent } from '../db/schema.js';

/** Transaction Drizzle (même interface d'écriture que la base elle-même). */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Writable = Database | Transaction;

/** Natures d'effet : diffusion temps réel, calcul des destinataires, push unitaire. */
export type MessageEventKind = 'socket' | 'push_fanout' | 'push';

/** Bail d'un worker sur une ligne : au-delà, un autre peut la reprendre. */
const LEASE_MS = 30_000;
/** Nombre de tentatives avant d'abandonner une ligne (fournisseur muet…). */
const MAX_ATTEMPTS = 5;
/** Report exponentiel simple entre deux tentatives. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export interface EnqueueInput {
  messageId: string;
  conversationId: string;
  /**
   * Destinataires autorisés au moment de l'envoi (membres moins l'expéditeur).
   * `null` : aucun push pour ce message (message système, avis d'appel).
   */
  audience: string[] | null;
}

/**
 * Journal durable des effets secondaires d'un message.
 *
 * Les lignes sont écrites **dans la transaction du message** : soit le message
 * et ses effets existent, soit aucun des deux. L'unicité
 * `(message_id, kind, user_id)` fait le reste — une requête répétée ne crée
 * aucune ligne, donc aucun nouvel envoi.
 *
 * Aucun état ne vit en mémoire : après un redémarrage, les lignes `pending`
 * sont simplement reprises.
 */
@Injectable()
export class MessageEventsService {
  private readonly logger = new Logger(MessageEventsService.name);

  /** Réveille le worker après un dépôt hors du chemin d'envoi d'un client. */
  onPending: (() => void) | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Dépose les effets d'un message.
   *
   * L'**audience** est gelée ici, dans la transaction du message : les
   * destinataires sont ceux qui étaient membres au moment de l'envoi. Un membre
   * ajouté plus tard ne recevra donc jamais la notification d'un ancien
   * message ; un membre retiré plus tard garde sa ligne (le retrait effectif
   * est vérifié au dispatch, sans réécrire l'audience).
   *
   * Idempotent : la contrainte d'unicité absorbe toute répétition, y compris
   * deux transactions concurrentes.
   */
  async enqueue(writer: Writable, input: EnqueueInput): Promise<void> {
    const rows: { kind: MessageEventKind; userId: string }[] = [
      { kind: 'socket', userId: '' },
    ];
    if (input.audience !== null) {
      for (const userId of input.audience) {
        rows.push({ kind: 'push', userId });
      }
    }
    await writer
      .insert(messageEvents)
      .values(
        rows.map((row) => ({
          messageId: input.messageId,
          conversationId: input.conversationId,
          kind: row.kind,
          userId: row.userId,
        })),
      )
      .onConflictDoNothing({
        target: [messageEvents.messageId, messageEvents.kind, messageEvents.userId],
      });
  }

  /** Signale qu'il y a du travail en attente (sans bloquer l'appelant). */
  wake(): void {
    this.onPending?.();
  }

  /**
   * Lignes traitables : en attente, échéance passée, bail libre ou expiré.
   * `SKIP LOCKED` n'est pas nécessaire ici : le bail est pris par un `UPDATE`
   * conditionnel, seule la tentative gagnante reçoit la ligne.
   */
  async dueRows(limit = 20, messageId?: string): Promise<MessageEvent[]> {
    const now = new Date();
    return this.db
      .select()
      .from(messageEvents)
      .where(
        and(
          eq(messageEvents.status, 'pending'),
          lte(messageEvents.nextAttemptAt, now),
          or(isNull(messageEvents.lockedUntil), lt(messageEvents.lockedUntil, now)),
          messageId ? eq(messageEvents.messageId, messageId) : undefined,
        ),
      )
      .orderBy(asc(messageEvents.createdAt))
      .limit(limit);
  }

  /**
   * Prend le bail d'une ligne et lui attribue un **jeton de propriété** neuf.
   * Retourne `null` si un autre worker l'a déjà prise (ou si le bail est
   * encore valide) : deux workers ne traitent jamais la même ligne en même
   * temps, et les mutations de fin de traitement vérifient le jeton.
   */
  async claim(id: string): Promise<MessageEvent | null> {
    const now = new Date();
    const token = crypto.randomUUID();
    const rows = await this.db
      .update(messageEvents)
      .set({
        lockedUntil: new Date(now.getTime() + LEASE_MS),
        claimToken: token,
        attempts: sql`${messageEvents.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(messageEvents.id, id),
          eq(messageEvents.status, 'pending'),
          or(isNull(messageEvents.lockedUntil), lt(messageEvents.lockedUntil, now)),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Effet terminal : la ligne ne sera plus jamais reprise. `reason` documente
   * le cas « rien à envoyer » (destinataire retiré, préférences coupées, message
   * disparu) : ce n'est pas un échec, donc pas une ligne à réarmer.
   *
   * **Fencé** : sans le jeton de la tentative courante, rien n'est écrit.
   * `false` signifie « bail perdu » — l'effet appartient désormais à un autre.
   */
  async markDone(id: string, token: string, reason: string | null = null): Promise<boolean> {
    const rows = await this.db
      .update(messageEvents)
      .set({
        status: 'done',
        lastError: reason,
        lockedUntil: null,
        claimToken: null,
        updatedAt: new Date(),
      })
      .where(and(eq(messageEvents.id, id), eq(messageEvents.claimToken, token)))
      .returning({ id: messageEvents.id });
    return rows.length > 0;
  }

  /**
   * Abandon après échecs : **seul** état réarmable (`retrySkipped`). Distinct
   * de `done` pour qu'une reprise administrative ne rejoue pas les lignes qui
   * n'avaient simplement rien à envoyer. Fencé comme `markDone`.
   */
  async markSkipped(id: string, token: string, error: string | null): Promise<boolean> {
    const rows = await this.db
      .update(messageEvents)
      .set({
        status: 'skipped',
        lastError: error,
        lockedUntil: null,
        claimToken: null,
        updatedAt: new Date(),
      })
      .where(and(eq(messageEvents.id, id), eq(messageEvents.claimToken, token)))
      .returning({ id: messageEvents.id });
    return rows.length > 0;
  }

  /**
   * Échec temporaire : la ligne reste `pending` et sera reprise. Au-delà de
   * `MAX_ATTEMPTS`, elle passe en `skipped` (jamais supprimée) avec la dernière
   * erreur, pour qu'une panne définitive ne tourne pas indéfiniment. Un
   * abandon est donc **visible en base**, journalisé en `error`, et réversible
   * par `retrySkipped`.
   */
  async reschedule(row: MessageEvent, token: string, error: string): Promise<boolean> {
    if (row.attempts >= MAX_ATTEMPTS) {
      this.logger.error(
        `Effet ${row.kind} abandonné (message ${row.messageId}, destinataire ${
          row.userId || '—'
        }) après ${row.attempts} tentatives: ${error}`,
      );
      return this.markSkipped(row.id, token, error);
    }
    const delay = Math.min(RETRY_BASE_MS * Math.max(1, row.attempts), RETRY_MAX_MS);
    const rows = await this.db
      .update(messageEvents)
      .set({
        lastError: error,
        lockedUntil: null,
        claimToken: null,
        nextAttemptAt: new Date(Date.now() + delay),
        updatedAt: new Date(),
      })
      .where(and(eq(messageEvents.id, row.id), eq(messageEvents.claimToken, token)))
      .returning({ id: messageEvents.id });
    return rows.length > 0;
  }

  /**
   * Relâche son propre bail (worker sans serveur temps réel…). Fencé : un
   * worker périmé ne peut pas libérer le bail de son successeur, ce qui
   * laisserait un troisième worker envoyer en double.
   */
  async release(id: string, token: string): Promise<boolean> {
    const rows = await this.db
      .update(messageEvents)
      .set({ lockedUntil: null, claimToken: null, updatedAt: new Date() })
      .where(and(eq(messageEvents.id, id), eq(messageEvents.claimToken, token)))
      .returning({ id: messageEvents.id });
    return rows.length > 0;
  }

  /**
   * Reprise **administrative** des effets abandonnés : les lignes `skipped`
   * repassent en attente, avec un compteur neuf. La ligne est réutilisée telle
   * quelle, donc aucune duplication logique possible, et le message n'est pas
   * recréé. Réservé à un opérateur (script `message-events-retry`).
   */
  async retrySkipped(filter: {
    messageId?: string;
    kinds?: MessageEventKind[];
    olderThanMs?: number;
  } = {}): Promise<number> {
    const conditions = [eq(messageEvents.status, 'skipped')];
    if (filter.messageId) {
      conditions.push(eq(messageEvents.messageId, filter.messageId));
    }
    if (filter.kinds && filter.kinds.length > 0) {
      conditions.push(inArray(messageEvents.kind, filter.kinds));
    }
    if (filter.olderThanMs) {
      conditions.push(lt(messageEvents.updatedAt, new Date(Date.now() - filter.olderThanMs)));
    }
    const now = new Date();
    const rows = await this.db
      .update(messageEvents)
      .set({
        status: 'pending',
        attempts: 0,
        lastError: null,
        lockedUntil: null,
        claimToken: null,
        nextAttemptAt: now,
        updatedAt: now,
      })
      .where(and(...conditions))
      .returning({ id: messageEvents.id });
    return rows.length;
  }

  /** Lignes d'un message, pour les tests et le diagnostic. */
  async listForMessage(messageId: string): Promise<MessageEvent[]> {
    return this.db
      .select()
      .from(messageEvents)
      .where(eq(messageEvents.messageId, messageId))
      .orderBy(asc(messageEvents.kind), asc(messageEvents.userId));
  }

  /**
   * Ménage. Les lignes closes ne servent plus à rien : les supprimer ne peut
   * pas ressusciter un effet, puisqu'un message déjà enregistré n'est jamais
   * réécrit pour un `clientId` donné.
   *
   * Les **abandons** (`skipped`) sont conservés plus longtemps que les succès :
   * c'est la seule trace exploitable par un opérateur, et elle doit survivre à
   * une absence prolongée.
   */
  async purgeFinished(doneAgeMs: number, skippedAgeMs = doneAgeMs * 3): Promise<void> {
    const now = Date.now();
    await this.db
      .delete(messageEvents)
      .where(
        or(
          and(
            eq(messageEvents.status, 'done'),
            lt(messageEvents.updatedAt, new Date(now - doneAgeMs)),
          ),
          and(
            eq(messageEvents.status, 'skipped'),
            lt(messageEvents.updatedAt, new Date(now - skippedAgeMs)),
          ),
        ),
      );
  }

  /** Nombre de lignes encore en attente (toutes conversations). */
  async pendingCount(): Promise<number> {
    const rows = await this.db.execute<{ cnt: number }>(
      sql`select count(*)::int as "cnt" from message_events where status = 'pending'`,
    );
    return Number(rows.rows[0]?.cnt ?? 0);
  }
}
