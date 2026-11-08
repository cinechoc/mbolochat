import type { SQLiteDatabase } from 'expo-sqlite';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import { ensureSocket } from '@/lib/socket';
import type { ConversationSummary, Message } from '@/lib/types';
import {
  deleteLocalMessage,
  loadE2eeAccount,
  loadLocalMessage,
  loadPeerSigningKey,
  loadSession,
  renameLocalMessage,
  saveLocalMessage,
  savePeerSigningKey,
  type E2eeAccountRow,
  type E2eeSessionRow,
  type StoredE2eeMessage,
} from './db';
import {
  buildTextV1,
  decodeMediaMeta,
  encodeMediaMeta,
  parsePayload,
  type EncryptedMedia,
} from './payload';
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
      const rotated = Boolean(knownKey && knownKey !== bundle.signingKey);
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

export async function sendEncryptedText(input: {
  token: string;
  db: SQLiteDatabase;
  account: E2eeAccountRow;
  conversation: ConversationSummary;
  currentUserId: string;
  currentUserName: string;
  text: string;
  allowKeyChange?: boolean;
  replyToId?: string | null;
  /** Identifiant client à réutiliser pour une reprise : même enveloppe, même
   * message. Absent, un nouvel identifiant est tiré. */
  clientId?: string;
  /** Reprise explicitement autorisée d'une enveloppe journalisée en échec. */
  resumeFailed?: boolean;
}): Promise<SendResult> {
  const clientId = input.clientId ?? newClientId();
  const encrypted = await encryptEnvelope({
    token: input.token,
    db: input.db,
    account: input.account,
    conversation: input.conversation,
    currentUserId: input.currentUserId,
    plaintext: buildTextV1(input.text, input.replyToId ?? undefined),
    allowKeyChange: input.allowKeyChange ?? false,
    // L'identifiant client est décidé **avant** le chiffrement : c'est la clé du
    // journal d'envoi. Une reprise réutilise le même, donc la même enveloppe.
    clientId,
    quoteId: input.replyToId ?? null,
    resumeFailed: input.resumeFailed ?? false,
  });
  const provisional: StoredE2eeMessage = {
    id: clientId,
    conversation_id: input.conversation.id,
    sender_id: input.currentUserId,
    sender_name: input.currentUserName,
    body: input.text,
    created_at: new Date().toISOString(),
    client_id: clientId,
    mine: 1,
    media_meta: null,
    quote_id: input.replyToId ?? null,
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
    keyChanged: Boolean(knownKey && knownKey !== bundle.signingKey),
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
 * Déchiffre un message entrant et persiste le résultat.
 *
 * Le déchiffrement, le contrôle de doublon et l'écriture se font sous le même
 * verrou de session, et l'écriture est une transaction unique : l'état Olm
 * avancé et le message ne sont jamais séparés. Un message déjà stocké ressort
 * tel quel, sans consommer de clé de ratchet une seconde fois.
 */
export async function decryptIncoming(input: {
  token: string;
  db: SQLiteDatabase;
  account: E2eeAccountRow;
  message: Message;
  currentUserId: string;
}): Promise<{
  text: string;
  media?: EncryptedMedia;
  account: E2eeAccountRow;
  stored: StoredE2eeMessage;
  keyChanged: boolean;
}> {
  const message = input.message;

  const replay = async () => {
    const existing = await loadLocalMessage(input.db, message.id);
    if (!existing) return null;
    // Doublon : la clé de ratchet a déjà été consommée, rien n'avance.
    return {
      text: existing.body,
      media: existing.media_meta ? decodeMediaMeta(existing.media_meta) ?? undefined : undefined,
      account: input.account,
      stored: existing,
      keyChanged: false,
    };
  };

  return runInbound(
    {
      token: input.token,
      db: input.db,
      account: input.account,
      message,
    },
    async (opened) => {
      const parsed = parsePayload(opened.plaintextB64);
      // Le corps affiché est le texte, ou la légende qui accompagne un média.
      const body = parsed.kind === 'text' ? parsed.text : parsed.caption;
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
        quote_id: parsed.replyTo ?? null,
      };
      await persistIncoming({
        db: input.db,
        session: opened.session,
        // `null` sur une session existante : le compte n'a pas bougé et une
        // écriture ici écraserait l'avancée faite par un autre pair.
        account: opened.accountChanged ? opened.account : null,
        message: stored,
        // Le pair est épinglé dès qu'il change de clé, ou à la première vue.
        pinPeerKey: opened.keyChanged || !opened.knownKey,
      });
      return {
        text: parsed.kind === 'text' ? parsed.text : parsed.caption,
        media: parsed.kind === 'media' ? parsed.media : undefined,
        account: opened.account,
        stored,
        keyChanged: opened.keyChanged,
      };
    },
    replay,
  );
}
