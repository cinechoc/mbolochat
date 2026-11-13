import { describe, expect, it } from 'vitest';

import type { StoredE2eeMessage } from '@/features/e2ee/db';
import type { ChatIdentity } from '@/features/chat/transport/types';
import type { Message, SenderInfo } from '@/lib/types';
import { classicMessageToView, identityOf, storedMessageToView } from './message-view';

const senderInfo = (id: string, displayName = id): SenderInfo => ({
  id,
  username: id,
  displayName,
  avatarUrl: null,
  gender: null,
  genderCustom: null,
});

const message = (input: Partial<Message> & Pick<Message, 'id'>): Message => ({
  conversationId: 'conversation-1',
  type: 'text',
  content: '',
  encryption: 'none',
  payload: null,
  payloadType: null,
  senderDeviceId: null,
  stickerRef: null,
  attachment: null,
  encryptedAttachment: null,
  clientId: null,
  deleted: false,
  replyTo: null,
  reactions: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  sender: senderInfo('me'),
  ...input,
});

const stored = (input: Partial<StoredE2eeMessage> & Pick<StoredE2eeMessage, 'id'>): StoredE2eeMessage => ({
  conversation_id: 'conversation-1',
  sender_id: 'peer',
  sender_name: 'Pair',
  body: '',
  created_at: '2026-01-01T00:00:00.000Z',
  client_id: null,
  mine: 0,
  media_meta: null,
  quote_id: null,
  sticker_ref: null,
  unreadable_reason: null,
  ...input,
});

const me: ChatIdentity = {
  id: 'me',
  username: 'me',
  displayName: 'Moi',
  avatarUrl: null,
  gender: null,
  genderCustom: null,
};

const peer: ChatIdentity = {
  id: 'peer',
  username: 'peer',
  displayName: 'Pair',
  avatarUrl: null,
  gender: null,
  genderCustom: null,
};

const MEDIA_META = JSON.stringify({
  type: 'IMAGE',
  mime: 'image/jpeg',
  width: 120,
  height: 90,
  blob: { uploadId: 'u1', fileKey: 'k', nonce: 'n', sha256: 'h', size: 42 },
});

describe('classicMessageToView', () => {
  it('mappe un message texte avec citation et état', () => {
    const view = classicMessageToView(
      message({
        id: 'm1',
        content: 'Bonjour',
        clientId: 'client-1',
        replyTo: {
          id: 'm0',
          senderName: 'Pair',
          content: 'Salut',
          type: 'text',
          attachmentType: null,
          deleted: false,
        },
      }),
      { currentUserId: 'me', state: 'pending' },
    );
    expect(view).toMatchObject({
      id: 'm1',
      clientId: 'client-1',
      mine: true,
      body: 'Bonjour',
      quoteId: 'm0',
      state: 'pending',
      unreadable: false,
    });
    expect(view.quote?.content).toBe('Salut');
  });

  it('mappe les métadonnées GIPHY d’une pièce jointe', () => {
    const view = classicMessageToView(
      message({
        id: 'g1',
        attachment: {
          type: 'GIF',
          url: 'https://media.giphy.com/x.gif',
          mime: 'image/gif',
          size: 10,
          width: 100,
          height: 100,
          giphyId: 'abc',
          username: 'auteur',
          title: 'titre',
          stillUrl: 'https://media.giphy.com/x.jpg',
          sticker: false,
        },
      }),
      { currentUserId: 'me' },
    );
    expect(view.attachment).toMatchObject({
      type: 'GIF',
      encrypted: false,
      giphy: {
        giphyId: 'abc',
        username: 'auteur',
        title: 'titre',
        stillUrl: 'https://media.giphy.com/x.jpg',
        sticker: false,
      },
    });
  });

  it('vide le corps d’un message supprimé pour tous', () => {
    const view = classicMessageToView(
      message({ id: 'd1', content: 'Secret', deleted: true }),
      { currentUserId: 'me' },
    );
    expect(view.body).toBe('');
    expect(view.deleted).toBe(true);
  });
});

describe('storedMessageToView', () => {
  it('mappe un message reçu avec l’identité du pair', () => {
    const view = storedMessageToView(stored({ id: 's1', body: 'Salut', quote_id: 's0' }), {
      currentUser: me,
      peer,
    });
    expect(view).toMatchObject({
      id: 's1',
      mine: false,
      body: 'Salut',
      quoteId: 's0',
      quote: null,
      unreadable: false,
    });
    expect(view.sender.displayName).toBe('Pair');
    expect(view.attachment).toBeNull();
  });

  it('mappe un média chiffré sans exposer d’URL claire', () => {
    const view = storedMessageToView(
      stored({ id: 's2', mine: 1, media_meta: MEDIA_META }),
      { currentUser: me, peer, state: 'sent' },
    );
    expect(view.mine).toBe(true);
    expect(view.state).toBe('sent');
    expect(view.attachment).toMatchObject({
      type: 'IMAGE',
      url: null,
      encrypted: true,
      mediaMeta: MEDIA_META,
      mime: 'image/jpeg',
      width: 120,
      height: 90,
    });
  });

  it('signale un message illisible sans exposer de contenu', () => {
    const view = storedMessageToView(
      stored({ id: 's3', body: '', unreadable_reason: 'unsupported_version' }),
      { currentUser: me, peer },
    );
    expect(view.unreadable).toBe(true);
    expect(view.body).toBe('');
  });

  it('conserve la référence de sticker reçue', () => {
    const view = storedMessageToView(
      stored({ id: 's4', sticker_ref: 'mbolo/merci' }),
      { currentUser: me, peer },
    );
    expect(view.stickerRef).toBe('mbolo/merci');
  });
});

describe('identityOf', () => {
  it('complète les champs absents', () => {
    expect(identityOf({ id: 'u1' })).toEqual({
      id: 'u1',
      username: '',
      displayName: '',
      avatarUrl: null,
      gender: null,
      genderCustom: null,
    });
  });
});
