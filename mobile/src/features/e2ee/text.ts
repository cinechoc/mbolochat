import type { SQLiteDatabase } from 'expo-sqlite';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import { ensureSocket } from '@/lib/socket';
import type { ConversationSummary, Message } from '@/lib/types';
import {
  deleteLocalMessage,
  loadConversationEphemeral,
  loadE2eeAccount,
  loadLocalMessage,
  loadPeerSigningKey,
  loadSession,
  MAX_UNKNOWN_PAYLOAD_CHARS,
  renameLocalMessage,
  saveConversationEphemeral,
  saveLocalMessage,
  savePeerSigningKey,
  type E2eeAccountRow,
  type E2eeSessionRow,
  type LocalMediaRefs,
  type StoredE2eeMessage,
} from './db';
import {
  buildDeleteV5,
  buildEditV7,
  buildEphemeralV6,
  buildReactionV4,
  buildStickerV3,
  buildTextV1,
  decodeMediaMeta,
  encodeMediaMeta,
  InvalidPayloadError,
  parsePayload,
  type EncryptedMedia,
  type EphemeralTtl,
  type ParsedPayload,
  type PayloadError,
  type ReactionAction,
} from './payload';
import type { ReactionRef } from '../stickers/reactionRules';
import {
  applyEditWith,
  nextEditRevision,
} from './edits';
import {
  loadPersistedEnvelope,
  markEnvelopeSent,
  persistIncoming,
  persistSessionAndEnvelope,
  type OutgoingEnvelope,
  type OutboxRecord,
} from './atomic';
import { withAccountLock, withOlmLock } from './locks';

export class E2eeKeyChangedError extends Error {
  constructor(
    readonly peerId: string,
    readonly signingKey: string,
  ) {
    super('key_changed');
  }
}

/** L'enveloppe a déjà été acquittée : la renvoyer créerait un doublon. */
export class E2eeAlreadySentError extends Error {
  constructor(
    readonly clientId: string,
    readonly messageId: string | null,
  ) {
    super('already_sent');
  }
}

/** Enveloppe en échec : sa reprise exige une action explicite de l'appelant. */
export class E2eeOutboxFailedError extends Error {
  constructor(
    readonly clientId: string,
    readonly reason: string | null,
  ) {
    super('outbox_failed');
  }
}

function newClientId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface SendResult {
  clientId: string;
  serverMessage: Message;
  stored: StoredE2eeMessage;
}

async function peerOf(
  conversation: ConversationSummary,
  currentUserId: string,
): Promise<{ id: string; name: string }> {
  const peer = conversation.members.find((member) => member.id !== currentUserId);
  if (!peer) {
    throw new Error('Conversation directe sans destinataire');
  }
  return { id: peer.id, name: peer.displayName };
}

/**
 * Chiffre un contenu déjà sérialisé (`plaintext`, base64) et gère la session Olm
 * avec le pair : réutilise la session existante, ou en ouvre une nouvelle en
 * consommant une prekey (ou le fallback). Détecte un changement de clé.
 *
 * Deux garanties forment le cœur de l'étape 1.1b :
 *  - toutes les mutations Olm (lecture de S0, chiffrement, écriture de S1) sont
 *    sérialisées par le verrou composite de `locks.ts` ; aucune opération réseau
 *    n'est exécutée en le tenant ;
 *  - S1 et l'enveloppe E sont écrites dans **une seule transaction exclusive**
 *    (`atomic.ts`), avec le seul handle `tx`. L'appelant n'envoie rien avant le
 *    retour de cette fonction, donc avant le commit.
 *
 * Exporté pour que le chemin média (`media.ts`) partage exactement la même
 * mécanique de session que le chemin texte : une seule implémentation à éprouver.
 */
export interface EncryptedEnvelope {
  payload: string;
  payloadType: 'prekey' | 'normal';
  peerId: string;
  signingKey: string;
  identityKey: string;
  deviceId: string;
}

/** Clé du verrou Olm : le compte local est identifié par son identité. */
function olmLockKey(account: E2eeAccountRow, peerId: string, peerDeviceId: string) {
  return { accountId: account.identity_key, peerUserId: peerId, peerDeviceId };
}

export async function encryptEnvelope(input: {
  token: string;
  db: SQLiteDatabase;
  account: E2eeAccountRow;
  conversation: ConversationSummary;
  currentUserId: string;
  plaintext: string;
  allowKeyChange: boolean;
  /**
   * Journal d'envoi. Fourni, l'enveloppe déjà persistée pour cet identifiant est
   * réutilisée telle quelle et E accompagne S1 dans la transaction exclusive.
   * Absent, l'enveloppe n'est pas journalisée (chemin média, étape ultérieure) :
   * seule la session est alors écrite.
   */
  clientId?: string | null;
  attachmentId?: string | null;
  mediaMeta?: string | null;
  quoteId?: string | null;
  /**
   * Autorisation explicite de reprendre une enveloppe journalisée en échec.
   * Sans ce drapeau, une enveloppe `failed` n'est jamais reprise toute seule.
   */
  resumeFailed?: boolean;
}): Promise<EncryptedEnvelope> {
  const peer = await peerOf(input.conversation, input.currentUserId);
  const clientId = input.clientId ?? null;

  // Sonde non consommatrice, hors verrou : elle donne l'appareil du pair — donc
  // la clé du verrou et l'identité de la ligne d'outbox — et détecte un
  // changement de clé sans brûler de prekey.
  let bundle = await api.getE2eeKeyBundle(input.token, peer.id, false);
  const now = () => new Date().toISOString();

  /** Identité écrite avec chaque nouvelle enveloppe (v3) ; `bundle` peut avoir
   * été relu entre-temps, d'où la fonction plutôt qu'une valeur figée. */
  const outboxFor = (): OutboxRecord | undefined =>
    clientId
      ? {
          clientId,
          conversationId: input.conversation.id,
          accountId: input.account.identity_key,
          peerUserId: peer.id,
          peerDeviceId: bundle.deviceId,
          attachmentId: input.attachmentId ?? null,
          mediaMeta: input.mediaMeta ?? null,
          quoteId: input.quoteId ?? null,
        }
      : undefined;

  /**
   * Applique la politique de reprise selon l'état journalisé :
   * `pending`/`sending` → réutilisation, `sent` → refus (aucun nouvel envoi),
   * `failed` → refus sauf autorisation explicite.
   */
  const reuse = async (): Promise<OutgoingEnvelope | null> => {
    if (!clientId) return null;
    const stored = await loadPersistedEnvelope(input.db, clientId);
    if (stored.status === 'none') return null;
    if (stored.status === 'sent') {
      throw new E2eeAlreadySentError(clientId, stored.messageId);
    }
    if (stored.status === 'failed' && !input.resumeFailed) {
      throw new E2eeOutboxFailedError(clientId, stored.error);
    }
    // `pending`, `sending`, et `failed` explicitement autorisé : E fait foi.
    return stored.envelope;
  };

  type Prepared =
    | { kind: 'envelope'; envelope: OutgoingEnvelope }
    | { kind: 'prekey'; clear: boolean };

  // Phase 1 : reprise éventuelle, puis session existante. Aucun réseau ici.
  const prepared = await withOlmLock(
    olmLockKey(input.account, peer.id, bundle.deviceId),
    async (): Promise<Prepared> => {
      // Une enveloppe déjà journalisée n'est jamais recalculée.
      const reused = await reuse();
      if (reused) return { kind: 'envelope', envelope: reused };
      const session = await loadSession(input.db, peer.id, bundle.deviceId);
      const knownKey =
        session?.peer_signing_key ??
        (await loadPeerSigningKey(input.db, peer.id, bundle.deviceId));
      const identityRotated = Boolean(
        session && session.peer_identity_key !== bundle.identityKey,
      );
      const rotated =
        identityRotated || Boolean(knownKey && knownKey !== bundle.signingKey);
      if (rotated && !input.allowKeyChange) {
        throw new E2eeKeyChangedError(peer.id, bundle.signingKey);
      }
      if (!session || rotated) {
        // Rotation : les anciennes sessions seront effacées dans la même
        // transaction que la nouvelle, jamais avant.
        return { kind: 'prekey', clear: rotated };
      }

      const sealed = await MboloCrypto.secureEncrypt(
        session.session_pickle,
        input.plaintext,
      );
      const envelope: OutgoingEnvelope = {
        payload: sealed.message,
        payloadType: sealed.message_type as OutgoingEnvelope['payloadType'],
      };
      const stored = await persistSessionAndEnvelope({
        db: input.db,
        session: {
          ...session,
          session_pickle: sealed.session_pickle,
          peer_identity_key: bundle.identityKey,
          peer_signing_key: bundle.signingKey,
          updated_at: now(),
        },
        envelope,
        outbox: outboxFor(),
        clearPeerSessions: false,
      });
      await savePeerSigningKey(input.db, peer.id, bundle.signingKey, true, bundle.deviceId);
      return { kind: 'envelope', envelope: stored ?? envelope };
    },
  );

  let committed = prepared.kind === 'envelope' ? prepared.envelope : null;

  if (!committed) {
    // Phase 2 : prekey réellement consommée, hors verrou car c'est du réseau.
    bundle = await api.getE2eeKeyBundle(input.token, peer.id, true);
    const prekey = bundle.oneTimeKey ?? bundle.fallback;
    if (!prekey || !prekey.signature) {
      throw new Error('prekey_unsigned');
    }
    const valid = await MboloCrypto.verifyPrekey(
      bundle.signingKey,
      prekey.key,
      prekey.signature,
    );
    if (!valid.valid) {
      throw new Error('prekey_signature_invalid');
    }
    const clear = prepared.kind === 'prekey' ? prepared.clear : false;

    committed = await withOlmLock(
      olmLockKey(input.account, peer.id, bundle.deviceId),
      async (): Promise<OutgoingEnvelope> => {
        const reused = await reuse();
        if (reused) return reused;
        const session = await loadSession(input.db, peer.id, bundle.deviceId);
        let nextPickle: string;
        let envelope: OutgoingEnvelope;
        if (session && !clear) {
          // Une autre tâche a ouvert la session entre les deux phases : son S0
          // fait foi. La prekey déjà consommée est perdue, jamais réutilisée.
          const sealed = await MboloCrypto.secureEncrypt(
            session.session_pickle,
            input.plaintext,
          );
          nextPickle = sealed.session_pickle;
          envelope = {
            payload: sealed.message,
            payloadType: sealed.message_type as OutgoingEnvelope['payloadType'],
          };
        } else {
          const outbound = await MboloCrypto.secureCreateOutbound(
            input.account.account_pickle,
            bundle.identityKey,
            prekey.key,
            input.plaintext,
          );
          nextPickle = outbound.session_pickle;
          envelope = {
            payload: outbound.message,
            payloadType: outbound.message_type as OutgoingEnvelope['payloadType'],
          };
        }
        const stored = await persistSessionAndEnvelope({
          db: input.db,
          session: {
            peer_user_id: peer.id,
            peer_device_id: bundle.deviceId,
            session_pickle: nextPickle,
            peer_identity_key: bundle.identityKey,
            peer_signing_key: bundle.signingKey,
            updated_at: now(),
          },
          envelope,
          outbox: outboxFor(),
          clearPeerSessions: clear,
        });
        await savePeerSigningKey(input.db, peer.id, bundle.signingKey, true, bundle.deviceId);
        return stored ?? envelope;
      },
    );
  }

  return {
    payload: committed.payload,
    payloadType: committed.payloadType,
    peerId: peer.id,
    signingKey: bundle.signingKey,
    identityKey: bundle.identityKey,
    deviceId: bundle.deviceId,
  };
}

export interface SendEncryptedContentInput {
  token: string;
  db: SQLiteDatabase;
  account: E2eeAccountRow;
  conversation: ConversationSummary;
  currentUserId: string;
  currentUserName: string;
  allowKeyChange?: boolean;
  replyToId?: string | null;
  /** Identifiant client à réutiliser pour une reprise : même enveloppe, même
   * message. Absent, un nouvel identifiant est tiré. */
  clientId?: string;
  /** Reprise explicitement autorisée d'une enveloppe journalisée en échec. */
  resumeFailed?: boolean;
}

interface OutgoingContent {
  body: string;
  quoteId?: string | null;
  stickerRef?: string | null;
  hidden?: boolean;
  contentKind?: string | null;
  controlTarget?: string | null;
  reaction?: string | null;
  reactionAction?: string | null;
  editRevision?: number | null;
  /** Les messages visibles reçoivent l'échéance éphémère courante. */
  applyEphemeral?: boolean;
}

/** Envoie un contenu déjà sérialisé par l'un des builders ci-dessus. */
async function sendEncryptedContent(
  input: SendEncryptedContentInput,
  plaintext: string,
  content: OutgoingContent,
): Promise<SendResult> {
  const clientId = input.clientId ?? newClientId();
  const createdAt = new Date().toISOString();
  let expiresAt: string | null = null;
  if (content.applyEphemeral) {
    const state = await loadConversationEphemeral(input.db, input.conversation.id);
    const ttl = state?.ephemeral_ttl_seconds ?? 0;
    if (ttl > 0) {
      const start = Date.parse(createdAt);
      if (Number.isFinite(start)) expiresAt = new Date(start + ttl * 1000).toISOString();
    }
  }
  const encrypted = await encryptEnvelope({
    token: input.token,
    db: input.db,
    account: input.account,
    conversation: input.conversation,
    currentUserId: input.currentUserId,
    plaintext,
    allowKeyChange: input.allowKeyChange ?? false,
    // L'identifiant client est décidé **avant** le chiffrement : c'est la clé du
    // journal d'envoi. Une reprise réutilise le même, donc la même enveloppe.
    clientId,
    quoteId: content.quoteId ?? null,
    resumeFailed: input.resumeFailed ?? false,
  });
  const provisional: StoredE2eeMessage = {
    id: clientId,
    conversation_id: input.conversation.id,
    sender_id: input.currentUserId,
    sender_name: input.currentUserName,
    body: content.body,
    created_at: createdAt,
    client_id: clientId,
    mine: 1,
    media_meta: null,
    quote_id: content.quoteId ?? null,
    sticker_ref: content.stickerRef ?? null,
    hidden: content.hidden ? 1 : 0,
    content_kind: content.contentKind ?? null,
    control_target: content.controlTarget ?? null,
    reaction: content.reaction ?? null,
    reaction_action: content.reactionAction ?? null,
    edit_revision: content.editRevision ?? 0,
    expires_at: expiresAt,
  };
  // La ligne provisoire est écrite avant l'envoi : un plantage entre les deux
  // ne doit pas rendre le message indéchiffrable et invisible.
  await saveLocalMessage(input.db, provisional);
  const socket = await ensureSocket(input.token);
  try {
    const result = (await socket
      .timeout(15000)
      .emitWithAck('message:send', {
        conversationId: input.conversation.id,
        content: '',
        encryption: 'v1',
        payload: encrypted.payload,
        payloadType: encrypted.payloadType,
        clientId,
      })) as Message | { error?: string };
    if ('error' in result && result.error) {
      throw new Error(result.error);
    }
    const serverMessage = result as Message;
    await renameLocalMessage(input.db, clientId, serverMessage.id);
    // L'enveloppe est acquittée : le journal la garde comme trace, mais une
    // reprise ne doit plus la renvoyer.
    await markEnvelopeSent(input.db, clientId, serverMessage.id);
    const stored: StoredE2eeMessage = { ...provisional, id: serverMessage.id, created_at: serverMessage.createdAt };
    return { clientId, serverMessage, stored };
  } catch (cause) {
    // Message local retiré, **enveloppe conservée** : une reprise avec le même
    // clientId repartira exactement du même E, sans faire avancer l'état Olm.
    await deleteLocalMessage(input.db, clientId).catch(() => undefined);
    throw cause;
  }
}

export async function sendEncryptedText(
  input: SendEncryptedContentInput & { text: string },
): Promise<SendResult> {
  return sendEncryptedContent(
    input,
    buildTextV1(input.text, input.replyToId ?? undefined),
    { body: input.text, quoteId: input.replyToId ?? null, applyEphemeral: true },
  );
}

export async function sendEncryptedSticker(
  input: SendEncryptedContentInput & { stickerRef: string },
): Promise<SendResult> {
  return sendEncryptedContent(input, buildStickerV3(input.stickerRef), {
    body: '',
    stickerRef: input.stickerRef,
    applyEphemeral: true,
  });
}

export async function sendEncryptedReaction(
  input: SendEncryptedContentInput & {
    targetId: string;
    reaction: ReactionRef;
    action: ReactionAction;
  },
): Promise<SendResult> {
  return sendEncryptedContent(
    input,
    buildReactionV4(input.targetId, input.reaction, input.action),
    {
      body: '',
      hidden: true,
      contentKind: 'reaction',
      controlTarget: input.targetId,
      reaction: input.reaction,
      reactionAction: input.action,
    },
  );
}

export async function sendEncryptedDelete(
  input: SendEncryptedContentInput & { targetId: string },
): Promise<SendResult> {
  return sendEncryptedContent(input, buildDeleteV5(input.targetId), {
    body: '',
    hidden: true,
    contentKind: 'delete',
    controlTarget: input.targetId,
  });
}

/**
 * Modifie un texte déjà envoyé. Les règles (auteur, fenêtre, révision) sont
 * vérifiées avant le chiffrement, puis de nouveau à l'application locale.
 */
export async function sendEncryptedEdit(
  input: SendEncryptedContentInput & { targetId: string; text: string },
): Promise<SendResult & { revision: number }> {
  const preparedAt = new Date().toISOString();
  const revision = await nextEditRevision(input.db, {
    targetId: input.targetId,
    authorId: input.currentUserId,
    conversationId: input.conversation.id,
    text: input.text,
    eventCreatedAt: preparedAt,
  });
  if (revision === null) {
    throw new Error('edit_not_allowed');
  }
  const result = await sendEncryptedContent(
    input,
    buildEditV7(input.targetId, revision, input.text),
    {
      body: '',
      hidden: true,
      contentKind: 'edit',
      controlTarget: input.targetId,
      editRevision: revision,
    },
  );
  await applyEditWith(input.db, {
    targetId: input.targetId,
    authorId: input.currentUserId,
    conversationId: input.conversation.id,
    revision,
    text: input.text,
    eventCreatedAt: result.stored.created_at,
  });
  return { ...result, revision };
}

export async function sendEncryptedEphemeral(
  input: SendEncryptedContentInput & { ttlSeconds: EphemeralTtl },
): Promise<SendResult & { ttlSeconds: EphemeralTtl; version: number }> {
  const current = await loadConversationEphemeral(input.db, input.conversation.id);
  const version = Math.max((current?.ephemeral_version ?? 0) + 1, Date.now());
  const result = await sendEncryptedContent(
    input,
    buildEphemeralV6(input.ttlSeconds, version),
    {
      body: '',
      hidden: true,
      contentKind: 'ephemeral',
      applyEphemeral: false,
    },
  );
  await saveConversationEphemeral(
    input.db,
    input.conversation.id,
    input.ttlSeconds,
    version,
  );
  return { ...result, ttlSeconds: input.ttlSeconds, version };
}

/** Résultat brut d'une ouverture : rien n'est encore écrit en base. */
interface OpenedInbound {
  plaintextB64: string;
  account: E2eeAccountRow;
  /**
   * Vrai seulement quand le pickle de **compte** a avancé (prekey consommée).
   * Une session entrante normale ne touche pas au compte : l'écrire quand même
   * écraserait l'avancée d'un autre pair avec une copie périmée.
   */
  accountChanged: boolean;
  session: E2eeSessionRow;
  keyChanged: boolean;
  /** La clé publique d'identité du pair diffère de celle de la session connue. */
  identityChanged: boolean;
  knownKey: string | null;
}

/** Forme publique du résultat d'ouverture : clair codé + session avancée. */
export type DecryptedEnvelope = OpenedInbound;

/** Une tentative sous verrou : soit c'est ouvert, soit il faut un bundle. */
type InboundAttempt =
  | { kind: 'opened'; opened: OpenedInbound }
  | { kind: 'needs_bundle' };

interface InboundInput {
  token: string;
  db: SQLiteDatabase;
  account: E2eeAccountRow;
  message: Message;
}

const nowIso = () => new Date().toISOString();

/**
 * Déchiffre avec la session locale, sans réseau ni bundle : appelé **sous
 * verrou**, c'est la seule lecture de session qui fasse foi.
 *
 * `deviceId` vide signifie « session la plus récente du pair » (messages
 * anciens, sans appareil déclaré) : c'est la clé de verrou déjà retenue par
 * l'appelant, pas une nouvelle découverte.
 */
async function attemptInbound(input: InboundInput, deviceId: string): Promise<InboundAttempt> {
  const peerId = input.message.sender.id;
  const knownKey = await loadPeerSigningKey(input.db, peerId, deviceId || undefined);
  const session = deviceId
    ? await loadSession(input.db, peerId, deviceId)
    : await loadSession(input.db, peerId);
  if (!session) {
    // Sans session, seule une enveloppe prekey peut en ouvrir une.
    if (input.message.payloadType !== 'prekey') throw new Error('missing_session');
    return { kind: 'needs_bundle' };
  }
  try {
    const decrypted = await MboloCrypto.secureDecrypt(
      session.session_pickle,
      input.message.payloadType ?? 'normal',
      input.message.payload!,
    );
    return {
      kind: 'opened',
      opened: {
        plaintextB64: decrypted.plaintext_b64,
        // Session entrante : le compte n'a pas bougé (cf. `decrypt` côté Rust).
        account: input.account,
        accountChanged: false,
        session: {
          ...session,
          session_pickle: decrypted.session_pickle,
          updated_at: nowIso(),
        },
        keyChanged: false,
        identityChanged: false,
        knownKey,
      },
    };
  } catch (cause) {
    // Le pair a changé d'identité et a ouvert une session depuis sa nouvelle
    // clé : sans repli prekey, sa première réponse serait perdue.
    if (input.message.payloadType !== 'prekey') throw cause;
    return { kind: 'needs_bundle' };
  }
}

/** Ouvre une session entrante depuis le bundle du pair (verrou tenu). */
async function openWithBundle(
  input: InboundInput,
  bundle: Awaited<ReturnType<typeof api.getE2eeKeyBundle>>,
): Promise<OpenedInbound> {
  const peerId = input.message.sender.id;
  const knownKey = await loadPeerSigningKey(input.db, peerId, bundle.deviceId);
  // Le changement d'identité est detecte avant d'écrire la nouvelle session ;
  // le signal existant `keyChanged` est réutilisé et étendu à cette clé.
  const previous =
    (await loadSession(input.db, peerId, bundle.deviceId)) ?? (await loadSession(input.db, peerId));
  const identityChanged = Boolean(
    previous && previous.peer_identity_key !== bundle.identityKey,
  );
  // Consomme la prekey : le pickle de compte avance, il doit donc être
  // persisté en même temps que la session et le message.
  const inbound = await MboloCrypto.secureCreateInbound(
    input.account.account_pickle,
    bundle.identityKey,
    input.message.payload!,
  );
  return {
    plaintextB64: inbound.plaintext_b64,
    account: { ...input.account, account_pickle: inbound.account_pickle },
    accountChanged: true,
    session: {
      peer_user_id: peerId,
      peer_device_id: bundle.deviceId,
      session_pickle: inbound.session_pickle,
      peer_identity_key: bundle.identityKey,
      peer_signing_key: bundle.signingKey,
      updated_at: nowIso(),
    },
    keyChanged:
      identityChanged || Boolean(knownKey && knownKey !== bundle.signingKey),
    identityChanged,
    knownKey,
  };
}

/**
 * Chemin entrant complet : deux phases séparées par la récupération du bundle.
 *
 * - phase 1 : verrou → doublon ? → session locale → déchiffrement → `finalize`
 * - si la session manque ou que le prekey échoue : bundle récupéré **hors
 *   verrou**, puis phase 2, qui redouble le contrôle de doublon et relit la
 *   session (une autre tâche a pu l'ouvrir entre-temps).
 *
 * `finalize` s'exécute sous le verrou : c'est là que la persistance atomique a
 * lieu, si bien qu'aucun autre déchiffrement ne peut lire un état intermédiaire.
 */
async function runInbound<T>(
  input: InboundInput,
  finalize: (opened: OpenedInbound) => Promise<T>,
  replay?: () => Promise<T | null>,
): Promise<T> {
  const message = input.message;
  if (message.encryption !== 'v1' || !message.payload) {
    throw new Error('not_encrypted');
  }
  const peerId = message.sender.id;
  const declared = message.senderDeviceId ?? '';
  // Lecture préalable : elle ne sert qu'à choisir la clé de verrou et à savoir
  // s'il existe une session. Aucun déchiffrement ne part d'ici.
  const local = await loadSession(input.db, peerId, declared || undefined);
  const deviceId = declared || local?.peer_device_id || '';
  const lock = {
    accountId: input.account.identity_key,
    peerUserId: peerId,
    peerDeviceId: deviceId,
  };

  if (local) {
    const first = await withOlmLock(lock, async () => {
      if (replay) {
        const already = await replay();
        if (already) return { kind: 'replay' as const, value: already };
      }
      const attempt = await attemptInbound(input, deviceId);
      if (attempt.kind === 'needs_bundle') return { kind: 'needs_bundle' as const };
      return { kind: 'done' as const, value: await finalize(attempt.opened) };
    });
    if (first.kind !== 'needs_bundle') return first.value;
  } else if (message.payloadType !== 'prekey') {
    // Rien à ouvrir et rien qui puisse ouvrir une session : inutile de prendre
    // le verrou pour l'apprendre.
    throw new Error('missing_session');
  }

  // Réseau : jamais sous le verrou.
  const bundle = await api.getE2eeKeyBundle(input.token, peerId, false);
  const second = await withOlmLock({ ...lock, peerDeviceId: bundle.deviceId }, async () => {
    if (replay) {
      const already = await replay();
      if (already) return already;
    }
    // Une session a pu être ouverte pendant la récupération du bundle : elle
    // prime, sinon la prekey serait consommée deux fois.
    const attempt = await attemptInbound(input, bundle.deviceId);
    if (attempt.kind === 'opened') return finalize(attempt.opened);
    // Consommer une prekey fait avancer le pickle **global** du compte : la
    // lecture qui fait foi est donc reprise sous le verrou de compte, sinon
    // deux pairs simultanés partiraient du même état et l'un écraserait l'autre.
    return withAccountLock(input.account.identity_key, async () => {
      const current = (await loadE2eeAccount(input.db)) ?? input.account;
      return finalize(await openWithBundle({ ...input, account: current }, bundle));
    });
  });
  return second;
}

/**
 * Ouvre une enveloppe Olm entrante : session existante, ou repli sur une
 * session entrante quand le pair a changé d'identité. Renvoie le clair codé et
 * la session avancée, sans rien interpréter du contenu — le décodage du payload
 * est laissé à l'appelant, qui sait s'il attend un texte ou un média.
 *
 * Le verrou de session est pris ici et **rien n'est persisté** : l'appelant doit
 * écrire la session et le résultat ensemble, via `persistIncoming`.
 */
export async function decryptEnvelope(input: InboundInput): Promise<DecryptedEnvelope> {
  return runInbound(input, async (opened) => opened);
}

/**
 * Persiste un message **authentifié mais illisible** dans la même transaction
 * que l'état Olm avancé.
 *
 * Le point critique : la session a déjà avancé chez l'expéditeur. Jeter cette
 * avancée laissait `e2ee_sessions` en arrière et rendait indéchiffrables **tous**
 * les messages suivants du même pair. On écrit donc la session — et le compte
 * s'il a bougé, et la clé épinglée — avec un message au corps vide portant un
 * motif normalisé. Aucun contenu n'est conservé : ni le clair déchiffré, ni le
 * message de l'exception, ni un fragment du payload.
 */
async function finalizeUnreadable(
  db: SQLiteDatabase,
  message: Message,
  opened: OpenedInbound,
  reason: PayloadError,
): Promise<DecryptIncomingResult> {
  const stored: StoredE2eeMessage = {
    id: message.id,
    conversation_id: message.conversationId,
    sender_id: message.sender.id,
    sender_name: message.sender.displayName,
    body: '',
    created_at: message.createdAt,
    client_id: message.clientId,
    mine: 0,
    media_meta: null,
    quote_id: null,
    sticker_ref: null,
    unreadable_reason: reason,
    hidden: 1,
    content_kind: 'unknown',
    // Un contenu futur trop volumineux n'est jamais conservé brut : la ligne
    // masquée suffit à l'idempotence et à l'avancement Olm.
    raw_payload:
      opened.plaintextB64.length <= MAX_UNKNOWN_PAYLOAD_CHARS ? opened.plaintextB64 : null,
  };
  await persistIncoming({
    db,
    session: opened.session,
    // `null` sur une session existante : le compte n'a pas bougé et l'écrire
    // écraserait l'avancée faite par un autre pair.
    account: opened.accountChanged ? opened.account : null,
    message: stored,
    pinPeerKey: opened.keyChanged || !opened.knownKey,
    identityChanged: opened.identityChanged,
  });
  return {
    text: '',
    media: undefined,
    stickerRef: undefined,
    unreadableReason: reason,
    hidden: true,
    reactionEvent: undefined,
    deletionEvent: undefined,
    account: opened.account,
    stored,
    keyChanged: opened.keyChanged,
  };
}

/**
 * Déchiffre un message entrant et persiste le résultat.
 *
 * Le déchiffrement, le contrôle de doublon et l'écriture se font sous le même
 * verrou de session, et l'écriture est une transaction unique : l'état Olm
 * avancé et le message ne sont jamais séparés. Un message déjà stocké ressort
 * tel quel, sans consommer de clé de ratchet une seconde fois.
 */
export interface IncomingReactionEvent {
  targetId: string;
  reaction: ReactionRef;
  action: ReactionAction;
  authorId: string;
}

export interface IncomingDeletionEvent {
  targetId: string;
  authorId: string;
  /** La cible était déjà locale et a été vidée pendant cette transaction. */
  applied: boolean;
  target?: StoredE2eeMessage;
  mediaRefs?: LocalMediaRefs | null;
}

export interface IncomingEphemeralEvent {
  ttlSeconds: number;
  version: number;
  /** Faux si une version plus récente était déjà appliquée localement. */
  applied: boolean;
  authorId: string;
}

export interface IncomingEditEvent {
  targetId: string;
  revision: number;
  authorId: string;
  /** Faux si la cible est inconnue, supprimée ou déjà plus récente. */
  applied: boolean;
  target?: StoredE2eeMessage;
}

export interface DecryptIncomingResult {
  text: string;
  media?: EncryptedMedia;
  /** Référence du sticker reçu (`v:3`), déjà validée par le parser. */
  stickerRef?: string;
  /**
   * Motif d'un contenu authentifié mais illisible (`unsupported_version`,
   * `invalid_payload`, `invalid_encoding`). Le message est alors persisté avec
   * un corps vide et ce motif : le ratchet, lui, a bien avancé.
   */
  unreadableReason?: PayloadError;
  /** Ligne de contrôle masquée : aucune bulle ne doit être émise. */
  hidden?: boolean;
  reactionEvent?: IncomingReactionEvent;
  deletionEvent?: IncomingDeletionEvent;
  ephemeralEvent?: IncomingEphemeralEvent;
  editEvent?: IncomingEditEvent;
  /** Médias locaux à nettoyer après une suppression appliquée hors événement v5. */
  deletedMediaRefs?: LocalMediaRefs | null;
  account: E2eeAccountRow;
  stored: StoredE2eeMessage;
  keyChanged: boolean;
}

export async function decryptIncoming(input: {
  token: string;
  db: SQLiteDatabase;
  account: E2eeAccountRow;
  message: Message;
  currentUserId: string;
}): Promise<DecryptIncomingResult> {
  const message = input.message;

  const reactionEventOf = (stored: StoredE2eeMessage): IncomingReactionEvent | undefined => {
    if (
      stored.content_kind !== 'reaction' ||
      typeof stored.control_target !== 'string' ||
      typeof stored.reaction !== 'string' ||
      (stored.reaction_action !== 'add' && stored.reaction_action !== 'remove')
    ) {
      return undefined;
    }
    return {
      targetId: stored.control_target,
      reaction: stored.reaction as ReactionRef,
      action: stored.reaction_action,
      authorId: stored.sender_id,
    };
  };

  const deletionEventOf = (stored: StoredE2eeMessage): IncomingDeletionEvent | undefined => {
    if (stored.content_kind !== 'delete' || typeof stored.control_target !== 'string') {
      return undefined;
    }
    return { targetId: stored.control_target, authorId: stored.sender_id, applied: false };
  };

  const replay = async () => {
    const existing = await loadLocalMessage(input.db, message.id);
    if (!existing) return null;
    // Doublon : la clé de ratchet a déjà été consommée, rien n'avance.
    return {
      text: existing.body,
      media: existing.media_meta ? decodeMediaMeta(existing.media_meta) ?? undefined : undefined,
      stickerRef: existing.sticker_ref ?? undefined,
      unreadableReason: (existing.unreadable_reason as PayloadError | null) ?? undefined,
      hidden: Boolean(existing.hidden),
      reactionEvent: reactionEventOf(existing),
      deletionEvent: deletionEventOf(existing),
      account: input.account,
      stored: existing,
      keyChanged: false,
    };
  };

  return runInbound<DecryptIncomingResult>(
    {
      token: input.token,
      db: input.db,
      account: input.account,
      message,
    },
    async (opened): Promise<DecryptIncomingResult> => {
      let parsed: ParsedPayload;
      try {
        parsed = parsePayload(opened.plaintextB64);
      } catch (error) {
        // Seul un contenu **authentifié mais illisible** prend ce chemin : le
        // déchiffrement Olm a réussi, c'est l'interprétation qui échoue. Une
        // erreur cryptographique (MAC, session absente, clé) n'est pas un
        // `InvalidPayloadError` et garde donc son traitement d'origine : rien
        // n'est persisté, le message n'est pas transformé en placeholder.
        if (!(error instanceof InvalidPayloadError)) throw error;
        return finalizeUnreadable(input.db, message, opened, error.reason);
      }
      // Le corps affiché est le texte, ou la légende qui accompagne un média.
      // Un sticker n'a pas de corps : sa référence suffit à l'affichage, et le
      // stocker à part évite une bulle de texte vide.
      const body =
        parsed.kind === 'text' ? parsed.text : parsed.kind === 'media' ? parsed.caption : '';
      let reactionEvent: IncomingReactionEvent | undefined;
      if (parsed.kind === 'reaction') {
        const event: IncomingReactionEvent = {
          targetId: parsed.targetId,
          reaction: parsed.reaction,
          action: parsed.action,
          authorId: message.sender.id,
        };
        reactionEvent = event;
      }
      const isReaction = parsed.kind === 'reaction';
      const isDelete = parsed.kind === 'delete';
      const isEphemeral = parsed.kind === 'ephemeral';
      const isEdit = parsed.kind === 'edit';
      const deleteTarget = parsed.kind === 'delete' ? parsed.targetId : null;
      const editTarget = parsed.kind === 'edit' ? parsed.targetId : null;
      const editRevision = parsed.kind === 'edit' ? parsed.revision : 0;
      const controlTarget =
        parsed.kind === 'reaction' || parsed.kind === 'delete' || parsed.kind === 'edit'
          ? parsed.targetId
          : null;
      const reaction = parsed.kind === 'reaction' ? parsed.reaction : null;
      const reactionAction = parsed.kind === 'reaction' ? parsed.action : null;
      const ephemeralState =
        parsed.kind === 'ephemeral'
          ? { ttlSeconds: parsed.ttlSeconds, version: parsed.version }
          : undefined;
      const currentTtl = isEphemeral
        ? 0
        : ((await loadConversationEphemeral(input.db, message.conversationId))
            ?.ephemeral_ttl_seconds ?? 0);
      const start = Date.parse(message.createdAt);
      const expiresAt =
        currentTtl > 0 && Number.isFinite(start)
          ? new Date(start + currentTtl * 1000).toISOString()
          : null;
      const stored: StoredE2eeMessage = {
        id: message.id,
        conversation_id: message.conversationId,
        sender_id: message.sender.id,
        sender_name: message.sender.displayName,
        body,
        created_at: message.createdAt,
        client_id: message.clientId,
        mine: 0,
        // Les clés du média ne vivent que dans la base chiffrée : c'est ici, et
        // nulle part ailleurs, qu'elles sont conservées pour une lecture ultérieure.
        media_meta: parsed.kind === 'media' ? encodeMediaMeta(parsed.media) : null,
        quote_id: 'replyTo' in parsed ? parsed.replyTo ?? null : null,
        // Référence validée par `parsePayload` : forme `pack/id` uniquement.
        // Rien d'autre n'en est tiré — ni URL, ni chemin, ni binaire.
        sticker_ref: parsed.kind === 'sticker' ? parsed.stickerRef : null,
        hidden: isReaction || isDelete || isEphemeral || isEdit ? 1 : 0,
        content_kind: isReaction
          ? 'reaction'
          : isDelete
            ? 'delete'
            : isEphemeral
              ? 'ephemeral'
              : isEdit
                ? 'edit'
                : null,
        control_target: controlTarget,
        reaction,
        reaction_action: reactionAction,
        edit_revision: editRevision,
        expires_at: expiresAt,
      };
      const persisted = await persistIncoming({
        db: input.db,
        session: opened.session,
        // `null` sur une session existante : le compte n'a pas bougé et une
        // écriture ici écraserait l'avancée faite par un autre pair.
        account: opened.accountChanged ? opened.account : null,
        message: stored,
        // Le pair est épinglé dès qu'il change de clé, ou à la première vue.
        pinPeerKey: opened.keyChanged || !opened.knownKey,
        identityChanged: opened.identityChanged,
        ephemeral: ephemeralState,
        edit:
          parsed.kind === 'edit'
            ? {
                targetId: parsed.targetId,
                revision: parsed.revision,
                text: parsed.text,
                eventCreatedAt: message.createdAt,
              }
            : undefined,
        deletion: deleteTarget
          ? {
              targetId: deleteTarget,
              authorId: message.sender.id,
              eventMessageId: message.id,
              createdAt: message.createdAt,
            }
          : undefined,
      });
      if (isEphemeral) {
        return {
          text: '',
          hidden: true,
          ephemeralEvent: {
            ttlSeconds: ephemeralState?.ttlSeconds ?? 0,
            version: ephemeralState?.version ?? 0,
            applied: Boolean(persisted.ephemeralApplied),
            authorId: message.sender.id,
          },
          account: opened.account,
          stored,
          keyChanged: opened.keyChanged,
        };
      }
      if (isDelete) {
        const targetId = deleteTarget ?? '';
        const target = persisted.deletion?.applied
          ? await loadLocalMessage(input.db, targetId)
          : null;
        return {
          text: '',
          hidden: true,
          deletionEvent: {
            targetId,
            authorId: message.sender.id,
            applied: Boolean(persisted.deletion?.applied),
            target: target ?? undefined,
            mediaRefs: persisted.deletion?.refs ?? null,
          },
          account: opened.account,
          stored,
          keyChanged: opened.keyChanged,
        };
      }
      if (isEdit) {
        const targetId = editTarget ?? '';
        const target = persisted.editApplied
          ? await loadLocalMessage(input.db, targetId)
          : null;
        return {
          text: '',
          hidden: true,
          editEvent: {
            targetId,
            revision: editRevision,
            authorId: message.sender.id,
            applied: Boolean(persisted.editApplied),
            target: target ?? undefined,
          },
          account: opened.account,
          stored,
          keyChanged: opened.keyChanged,
        };
      }
      const finalStored = persisted.deletion?.applied
        ? {
            ...stored,
            body: '',
            media_meta: null,
            quote_id: null,
            sticker_ref: null,
            deleted: 1,
            deleted_by: message.sender.id,
          }
        : stored;
      return {
        text: finalStored.body,
        media:
          parsed.kind === 'media' && !persisted.deletion?.applied ? parsed.media : undefined,
        stickerRef: parsed.kind === 'sticker' ? parsed.stickerRef : undefined,
        hidden: isReaction || isEdit,
        reactionEvent,
        account: opened.account,
        stored: finalStored,
        deletedMediaRefs: persisted.deletion?.refs ?? null,
        keyChanged: opened.keyChanged,
      };
    },
    replay,
  );
}
