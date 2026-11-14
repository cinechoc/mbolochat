import type { SQLiteDatabase } from 'expo-sqlite';

import {
  pruneUnknownPayloadsWith,
  saveE2eeAccountWith,
  saveLocalMessageWith,
  savePeerSigningKeyWith,
  saveSessionWith,
  type E2eeAccountRow,
  type E2eeSessionRow,
  type StoredE2eeMessage,
} from './db';
import {
  addDeletionTombstone,
  applyDeleteForAll,
  hasDeletionTombstone,
  type DeleteForAllResult,
} from './deletion';

/**
 * Écriture atomique de l'état de session S1 et de l'enveloppe E.
 *
 * Le chiffrement Olm fait avancer la session : l'enveloppe produite n'est
 * déchiffrable que par le S1 correspondant. Écrire l'un sans l'autre laisse la
 * base soit avec une session en avance sur une enveloppe jamais envoyée, soit
 * avec une enveloppe dont la session a déjà tourné. Les deux écritures passent
 * donc par une seule transaction, écrite par `inWriteTransaction` ci-dessous.
 */

/**
 * File d'attente des écritures transactionnelles de ce processus.
 *
 * `withExclusiveTransactionAsync` d'expo-sqlite **ouvre une connexion native
 * supplémentaire** (`useNewConnection: true`) sans lui réappliquer le `PRAGMA
 * key` : sur SQLCipher, le premier accès à cette connexion échoue en
 * `SQLITE_NOTADB` (erreur 26, « file is not a database »), constaté sur
 * appareil. La transaction est donc ouverte à la main sur la connexion déjà
 * déverrouillée — et c'est ce module qui fournit l'exclusivité : une seule
 * transaction est ouverte à la fois, quel que soit l'ordre d'arrivée des tâches
 * asynchrones.
 */
let writeTurn: Promise<unknown> = Promise.resolve();
let transactionOpen = false;

/** Exécute `task` après toutes les écritures déjà en file. */
function withWriteTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = writeTurn.then(task, task);
  writeTurn = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Ouvre une transaction exclusive sur une connexion SQLCipher déjà déverrouillée.
 *
 * `BEGIN IMMEDIATE` prend le verrou d'écriture dès l'ouverture : la transaction
 * ne peut pas échouer au commit parce qu'une autre écriture a gagné entre-temps.
 * Un appel imbriqué est une erreur de programmation, pas une attente : il
 * lèverait un interblocage, il est donc refusé.
 */
async function inWriteTransaction<T>(
  db: SQLiteDatabase,
  task: () => Promise<T>,
): Promise<T> {
  return withWriteTurn(async () => {
    if (transactionOpen) throw new Error('nested_write_transaction');
    transactionOpen = true;
    await db.execAsync('BEGIN IMMEDIATE');
    try {
      const value = await task();
      await db.execAsync('COMMIT');
      return value;
    } catch (cause) {
      try {
        await db.execAsync('ROLLBACK');
      } catch {
        // SQLite a déjà annulé la transaction (contrainte, disque plein).
      }
      throw cause;
    } finally {
      transactionOpen = false;
    }
  });
}

export interface OutgoingEnvelope {
  payload: string;
  payloadType: 'prekey' | 'normal';
}

export interface OutboxRecord {
  clientId: string;
  conversationId: string;
  /** Identité de la session visée : ces trois valeurs sont désormais écrites
   * avec chaque nouvelle enveloppe (les lignes antérieures gardent `NULL`). */
  accountId: string;
  peerUserId: string;
  peerDeviceId: string;
  attachmentId?: string | null;
  mediaMeta?: string | null;
  quoteId?: string | null;
}

export interface PersistSessionInput {
  db: SQLiteDatabase;
  /** S1 : le pickle rendu par `secureEncrypt`/`secureCreateOutbound`. */
  session: E2eeSessionRow;
  /** Enveloppe déjà chiffrée (E) — jamais recalculée ici. */
  envelope?: OutgoingEnvelope;
  /** Journal d'envoi. Absent (chemin média aujourd'hui) : seule S1 est écrite. */
  outbox?: OutboxRecord;
  /**
   * Rotation d'identité : les sessions des autres appareils de ce pair doivent
   * disparaître en même temps que la nouvelle est écrite, sinon un S0 périmé
   * survit à côté de la nouvelle clé.
   */
  clearPeerSessions?: boolean;
}

interface OutboxRow {
  envelope: string;
  envelope_type: string;
  state: string;
  message_id: string | null;
  last_error: string | null;
}

/** Résultat d'une tentative de reprise, selon l'état journalisé. */
export type PersistedEnvelope =
  /** Rien n'est journalisé : il faut chiffrer. */
  | { status: 'none' }
  /** En cours d'envoi : l'enveloppe existante est reprise telle quelle. */
  | { status: 'reusable'; state: 'pending' | 'sending'; envelope: OutgoingEnvelope }
  /** Déjà acquittée : surtout aucune nouvelle émission. */
  | { status: 'sent'; envelope: OutgoingEnvelope; messageId: string | null }
  /** En échec : reprise seulement sur action explicite de l'appelant. */
  | { status: 'failed'; envelope: OutgoingEnvelope; error: string | null };

/**
 * État de l'enveloppe déjà journalisée pour ce `clientId`.
 *
 * Lecture sans transaction : l'appelant la fait sous le verrou Olm, avant tout
 * chiffrement, pour ne jamais recalculer E. Les quatre états sont distingués
 * ici même, et non chez l'appelant, pour qu'aucun chemin ne puisse traiter un
 * `sent` comme un `pending`.
 */
export async function loadPersistedEnvelope(
  db: SQLiteDatabase,
  clientId: string,
): Promise<PersistedEnvelope> {
  const row = await db.getFirstAsync<OutboxRow>(
    `SELECT envelope, envelope_type, state, message_id, last_error
     FROM e2ee_outbox WHERE client_id = ?`,
    clientId,
  );
  if (!row) return { status: 'none' };
  const envelope: OutgoingEnvelope = {
    payload: row.envelope,
    payloadType: row.envelope_type as OutgoingEnvelope['payloadType'],
  };
  if (row.state === 'sent') {
    return { status: 'sent', envelope, messageId: row.message_id };
  }
  if (row.state === 'failed') {
    return { status: 'failed', envelope, error: row.last_error };
  }
  // `pending` et `sending` sont tous les deux en vol : l'enveloppe est reprise.
  return { status: 'reusable', state: row.state === 'sending' ? 'sending' : 'pending', envelope };
}

/**
 * Met à jour `e2ee_sessions` avec S1 et enregistre E dans `e2ee_outbox`, dans
 * une seule transaction exclusive.
 *
 * Retourne l'enveloppe effectivement stockée : si une enveloppe existait déjà
 * pour ce `clientId`, c'est **elle** qui est renvoyée et ni S1 ni E ne sont
 * réécrits — la première écriture gagne, y compris en cas de reprise.
 *
 * Ne fait aucune opération réseau : l'appelant envoie E seulement après retour
 * de cette fonction, donc après le commit.
 */
export async function persistSessionAndEnvelope(
  input: PersistSessionInput,
): Promise<OutgoingEnvelope | null> {
  // La valeur du callback n'est lue qu'après le commit.
  let stored: OutgoingEnvelope | null = null;
  await inWriteTransaction(input.db, async () => {
    const tx = input.db;
    if (input.outbox) {
      // Relecture dans la transaction : c'est elle qui décide, pas l'appelant.
      const existing = await tx.getFirstAsync<OutboxRow>(
        `SELECT envelope, envelope_type, state, message_id, last_error
         FROM e2ee_outbox WHERE client_id = ?`,
        input.outbox.clientId,
      );
      if (existing) {
        if (existing.state === 'sent') {
          // Acquittée : avancer S1 sans enveloppe correspondante rendrait toute
          // reprise ultérieure indéchiffrable. On refuse plutôt que d'écrire.
          throw new Error('outbox_sent');
        }
        // Une enveloppe déjà persistée fait foi : on n'écrit pas S1 au-dessus,
        // sinon la session avancerait sans enveloppe correspondante.
        stored = {
          payload: existing.envelope,
          payloadType: existing.envelope_type as OutgoingEnvelope['payloadType'],
        };
        return;
      }
    }

    if (input.clearPeerSessions) {
      await tx.runAsync(
        'DELETE FROM e2ee_sessions WHERE peer_user_id = ?',
        input.session.peer_user_id,
      );
    }
    await saveSessionWith(tx, input.session);

    if (!input.outbox) {
      stored = input.envelope ?? null;
      return;
    }

    const now = new Date().toISOString();
    // `session_pickle` reste vide : S1 est la seule copie qui fait foi, dans
    // `e2ee_sessions`. Dupliquer le pickle ici créerait deux états divergents
    // dès l'envoi suivant.
    await tx.runAsync(
      `INSERT INTO e2ee_outbox
         (client_id, conversation_id, account_id, peer_user_id, peer_device_id,
          message_id, envelope, envelope_type, session_pickle, attachment_id,
          media_meta, quote_id, state, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, '', ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
      input.outbox.clientId,
      input.outbox.conversationId,
      input.outbox.accountId,
      input.outbox.peerUserId,
      input.outbox.peerDeviceId,
      input.envelope?.payload ?? '',
      input.envelope?.payloadType ?? 'normal',
      input.outbox.attachmentId ?? null,
      input.outbox.mediaMeta ?? null,
      input.outbox.quoteId ?? null,
      now,
      now,
    );

    stored = input.envelope ?? null;
  });

  return stored;
}

/** Marque une enveloppe comme envoyée (accusé reçu). Hors périmètre réseau. */
export async function markEnvelopeSent(
  db: SQLiteDatabase,
  clientId: string,
  serverMessageId: string | null,
): Promise<void> {
  await db.runAsync(
    `UPDATE e2ee_outbox
     SET state = 'sent', message_id = ?, updated_at = ?
     WHERE client_id = ?`,
    serverMessageId,
    new Date().toISOString(),
    clientId,
  );
}

/**
 * Écriture atomique d'un message entrant déchiffré.
 *
 * Le déchiffrement Olm fait avancer la session (et, sur une prekey, le compte) :
 * enregistrer le message sans l'état avancé rejouerait une clé de ratchet déjà
 * consommée, et enregistrer l'état sans le message perdrait le clair de façon
 * définitive. Les quatre écritures passent donc par une seule transaction
 * exclusive, ouverte sur la connexion déjà déverrouillée.
 */
export interface PersistIncomingInput {
  db: SQLiteDatabase;
  /** S1 : état après déchiffrement. */
  session: E2eeSessionRow;
  /**
   * Compte après consommation d'une éventuelle prekey, ou `null` quand le
   * déchiffrement n'a pas touché au pickle global : l'écrire quand même
   * écraserait l'avancée d'un autre pair avec une copie périmée.
   */
  account?: E2eeAccountRow | null;
  /** Le clair décodé et ses métadonnées. */
  message: StoredE2eeMessage;
  /** Épingler la clé de signature du pair (première vue ou changement). */
  pinPeerKey?: boolean;
  /**
   * Événement de suppression pour tous : la tombstone, l'application à la
   * cible et l'avancement Olm sont écrits ensemble.
   */
  deletion?: {
    targetId: string;
    authorId: string;
    eventMessageId: string;
    createdAt: string;
  };
}

export interface PersistIncomingResult {
  deletion?: DeleteForAllResult;
}

export async function persistIncoming(
  input: PersistIncomingInput,
): Promise<PersistIncomingResult> {
  const result: PersistIncomingResult = {};
  await inWriteTransaction(input.db, async () => {
    const tx = input.db;
    if (input.deletion) {
      await addDeletionTombstone(tx, input.deletion);
    }
    await saveLocalMessageWith(tx, input.message);
    if (input.message.content_kind === 'unknown') {
      await pruneUnknownPayloadsWith(tx, input.message.conversation_id);
    }
    if (input.message.hidden !== 1) {
      const tombstoned = await hasDeletionTombstone(
        tx,
        input.message.id,
        input.message.sender_id,
        input.message.conversation_id,
      );
      if (tombstoned) {
        result.deletion = await applyDeleteForAll(
          tx,
          input.message.id,
          input.message.sender_id,
          input.message.conversation_id,
        );
      }
    }
    if (input.deletion) {
      result.deletion = await applyDeleteForAll(
        tx,
        input.deletion.targetId,
        input.deletion.authorId,
        input.message.conversation_id,
      );
    }
    await saveSessionWith(tx, input.session);
    if (input.account) await saveE2eeAccountWith(tx, input.account);
    if (input.pinPeerKey) {
      await savePeerSigningKeyWith(
        tx,
        input.session.peer_user_id,
        input.session.peer_signing_key,
        true,
        input.session.peer_device_id,
      );
    }
  });
  return result;
}

/** Références média d'une entrée d'outbox : de quoi reprendre sans rien recalculer. */
export interface OutboxMediaRefs {
  state: string;
  attachmentId: string | null;
  mediaMeta: string | null;
  quoteId: string | null;
}

/**
 * Relit les références média journalisées pour un `clientId`.
 *
 * Le journal est volontairement autosuffisant : l'enveloppe, l'identifiant
 * d'upload et la description du média y sont écrits, si bien qu'une reprise ne
 * dépend ni de la ligne de message provisoire (supprimée en cas d'échec) ni du
 * moindre chiffrement à refaire.
 */
export async function loadOutboxMediaRefs(
  db: SQLiteDatabase,
  clientId: string,
): Promise<OutboxMediaRefs | null> {
  const row = await db.getFirstAsync<{
    state: string;
    attachment_id: string | null;
    media_meta: string | null;
    quote_id: string | null;
  }>(
    `SELECT state, attachment_id, media_meta, quote_id
     FROM e2ee_outbox WHERE client_id = ?`,
    clientId,
  );
  if (!row) return null;
  return {
    state: row.state,
    attachmentId: row.attachment_id,
    mediaMeta: row.media_meta,
    quoteId: row.quote_id,
  };
}
