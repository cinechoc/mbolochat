import { fromByteArray, toByteArray } from 'base64-js';
import type { SQLiteDatabase } from 'expo-sqlite';

import { MboloCrypto } from '../../../modules/mbolo-crypto/src';
import { api } from '@/lib/api';
import { ensureSocket } from '@/lib/socket';
import type { ConversationSummary, Message } from '@/lib/types';
import {
  deleteLocalMessage,
  loadPeerSigningKey,
  loadSession,
  renameLocalMessage,
  saveLocalMessage,
  savePeerSigningKey,
  saveSession,
  type E2eeAccountRow,
  type E2eeSessionRow,
  type StoredE2eeMessage,
} from './db';

export class E2eeKeyChangedError extends Error {
  constructor(
    readonly peerId: string,
    readonly signingKey: string,
  ) {
    super('key_changed');
  }
}

function encodeText(value: string): string {
  const encoded = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === '%') {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  return fromByteArray(Uint8Array.from(bytes));
}

function decodeText(value: string): string {
  const bytes = toByteArray(value);
  let encoded = '';
  for (const byte of bytes) {
    encoded += `%${byte.toString(16).padStart(2, '0')}`;
  }
  return decodeURIComponent(encoded);
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

async function encryptPayload(input: {
  token: string;
  db: SQLiteDatabase;
  account: E2eeAccountRow;
  conversation: ConversationSummary;
  currentUserId: string;
  text: string;
  allowKeyChange: boolean;
}): Promise<{ payload: string; payloadType: 'prekey' | 'normal'; peerId: string; signingKey: string; identityKey: string; deviceId: string }> {
  const peer = await peerOf(input.conversation, input.currentUserId);
  let session = await loadSession(input.db, peer.id);
  // Lecture non consommatrice pour détecter un changement de clé sans brûler
  // une prekey à chaque message.
  let bundle = await api.getE2eeKeyBundle(input.token, peer.id, false);

  const knownKey = session?.peer_signing_key ?? (await loadPeerSigningKey(input.db, peer.id));
  if (knownKey && knownKey !== bundle.signingKey) {
    if (!input.allowKeyChange) {
      throw new E2eeKeyChangedError(peer.id, bundle.signingKey);
    }
    await input.db.runAsync('DELETE FROM e2ee_sessions WHERE peer_user_id = ?', peer.id);
    session = null;
  }

  const plaintext = encodeText(JSON.stringify({ v: 1, text: input.text }));
  let result;
  if (session) {
    const envelope = await MboloCrypto.secureEncrypt(session.session_pickle, plaintext);
    result = {
      sessionPickle: envelope.session_pickle,
      messageType: envelope.message_type,
      message: envelope.message,
    };
  } else {
    // Première session : on consomme une prekey à usage unique (ou le fallback).
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
    const outbound = await MboloCrypto.secureCreateOutbound(
      input.account.account_pickle,
      bundle.identityKey,
      prekey.key,
      plaintext,
    );
    result = {
      sessionPickle: outbound.session_pickle,
      messageType: outbound.message_type,
      message: outbound.message,
    };
  }

  const now = new Date().toISOString();
  const nextSession: E2eeSessionRow = {
    peer_user_id: peer.id,
    peer_device_id: bundle.deviceId,
    session_pickle: result.sessionPickle,
    peer_identity_key: bundle.identityKey,
    peer_signing_key: bundle.signingKey,
    updated_at: now,
  };
  await saveSession(input.db, nextSession);
  await savePeerSigningKey(input.db, peer.id, bundle.signingKey, true);

  return {
    payload: result.message,
    payloadType: result.messageType as 'prekey' | 'normal',
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
}): Promise<SendResult> {
  const encrypted = await encryptPayload({
    token: input.token,
    db: input.db,
    account: input.account,
    conversation: input.conversation,
    currentUserId: input.currentUserId,
    text: input.text,
    allowKeyChange: input.allowKeyChange ?? false,
  });
  const clientId = newClientId();
  const provisional: StoredE2eeMessage = {
    id: clientId,
    conversation_id: input.conversation.id,
    sender_id: input.currentUserId,
    sender_name: input.currentUserName,
    body: input.text,
    created_at: new Date().toISOString(),
    client_id: clientId,
    mine: 1,
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
        replyToId: input.replyToId ?? undefined,
      })) as Message | { error?: string };
    if ('error' in result && result.error) {
      throw new Error(result.error);
    }
    const serverMessage = result as Message;
    await renameLocalMessage(input.db, clientId, serverMessage.id);
    const stored: StoredE2eeMessage = { ...provisional, id: serverMessage.id, created_at: serverMessage.createdAt };
    return { clientId, serverMessage, stored };
  } catch (cause) {
    await deleteLocalMessage(input.db, clientId).catch(() => undefined);
    throw cause;
  }
}

export async function decryptIncoming(input: {
  token: string;
  db: SQLiteDatabase;
  account: E2eeAccountRow;
  message: Message;
  currentUserId: string;
}): Promise<{ text: string; account: E2eeAccountRow; stored: StoredE2eeMessage; keyChanged: boolean }> {
  const message = input.message;
  if (message.encryption !== 'v1' || !message.payload) {
    throw new Error('not_encrypted');
  }
  const peerId = message.sender.id;
  let session = await loadSession(input.db, peerId);
  let account = input.account;
  let plaintextB64: string;
  const knownKey = await loadPeerSigningKey(input.db, peerId);
  let keyChanged = false;

  const openInbound = async (
    identityKey: string,
    deviceId: string,
    signingKey: string,
  ): Promise<{
    plaintextB64: string;
    account: E2eeAccountRow;
    session: E2eeSessionRow;
    keyChanged: boolean;
  }> => {
    const inbound = await MboloCrypto.secureCreateInbound(
      account.account_pickle,
      identityKey,
      message.payload!,
    );
    return {
      plaintextB64: inbound.plaintext_b64,
      account: { ...account, account_pickle: inbound.account_pickle },
      keyChanged: Boolean(knownKey && knownKey !== signingKey),
      session: {
        peer_user_id: peerId,
        peer_device_id: deviceId,
        session_pickle: inbound.session_pickle,
        peer_identity_key: identityKey,
        peer_signing_key: signingKey,
        updated_at: new Date().toISOString(),
      },
    };
  };

  if (session) {
    try {
      const decrypted = await MboloCrypto.secureDecrypt(
        session.session_pickle,
        message.payloadType ?? 'normal',
        message.payload,
      );
      plaintextB64 = decrypted.plaintext_b64;
      session = {
        ...session,
        session_pickle: decrypted.session_pickle,
        updated_at: new Date().toISOString(),
      };
    } catch (cause) {
      // Le pair a changé d'identité et a ouvert une session depuis sa
      // nouvelle clé : sans repli, sa première réponse serait perdue.
      if (message.payloadType !== 'prekey') {
        throw cause;
      }
      const bundle = await api.getE2eeKeyBundle(input.token, peerId, false);
      const opened = await openInbound(bundle.identityKey, bundle.deviceId, bundle.signingKey);
      account = opened.account;
      session = opened.session;
      plaintextB64 = opened.plaintextB64;
      keyChanged = opened.keyChanged;
    }
  } else {
    if (message.payloadType !== 'prekey') {
      throw new Error('missing_session');
    }
    const bundle = await api.getE2eeKeyBundle(input.token, peerId, false);
    const opened = await openInbound(bundle.identityKey, bundle.deviceId, bundle.signingKey);
    account = opened.account;
    session = opened.session;
    plaintextB64 = opened.plaintextB64;
    keyChanged = opened.keyChanged;
  }

  let parsed: { v?: number; text?: string };
  try {
    parsed = JSON.parse(decodeText(plaintextB64)) as { v?: number; text?: string };
  } catch {
    throw new Error('invalid_payload');
  }
  if (parsed.v !== 1 || typeof parsed.text !== 'string') {
    throw new Error('invalid_payload');
  }

  const stored: StoredE2eeMessage = {
    id: message.id,
    conversation_id: message.conversationId,
    sender_id: message.sender.id,
    sender_name: message.sender.displayName,
    body: parsed.text,
    created_at: message.createdAt,
    client_id: message.clientId,
    mine: 0,
  };
  // Le texte est écrit avant que la session n'avance : un plantage entre les
  // deux laisse le message récupérable plutôt que définitivement perdu.
  await saveLocalMessage(input.db, stored);
  await saveSession(input.db, session);
  if (keyChanged || !knownKey) {
    await savePeerSigningKey(input.db, peerId, session.peer_signing_key, true);
  }
  return { text: parsed.text, account, stored, keyChanged };
}
