import { describe, expect, it } from 'vitest';
import { notificationText } from '../src/push/push.service.js';
import type { MessageDto } from '../src/conversations/conversations.service.js';

const base = {
  type: 'text' as const,
  content: '',
  attachment: null,
};

describe('notificationText', () => {
  it('annonce un sticker par son type, jamais par sa référence', () => {
    expect(notificationText({ ...base, type: 'sticker' } as MessageDto)).toBe('Sticker');
  });

  it('garde le texte normal', () => {
    expect(notificationText({ ...base, content: 'Salut' } as MessageDto)).toBe('Salut');
  });

  it('décrit les pièces jointes sans légende', () => {
    expect(
      notificationText({
        ...base,
        attachment: { type: 'IMAGE', url: '/media?f=1', mime: 'image/jpeg', size: 1 },
      } as MessageDto),
    ).toBe('📷 Photo');
    expect(
      notificationText({
        ...base,
        attachment: { type: 'AUDIO', url: '/media?f=2', mime: 'audio/mp4', size: 1 },
      } as MessageDto),
    ).toBe('🎤 Message vocal');
  });

  it('privilégie la légende quand elle existe', () => {
    expect(
      notificationText({
        ...base,
        content: 'Regarde',
        attachment: { type: 'IMAGE', url: '/media?f=1', mime: 'image/jpeg', size: 1 },
      } as MessageDto),
    ).toBe('Regarde');
  });

  it('masque le texte quand les aperçus sont désactivés', () => {
    expect(notificationText({ ...base, content: 'Secret' } as MessageDto, false)).toBe(
      'Nouveau message',
    );
    expect(
      notificationText(
        {
          ...base,
          attachment: { type: 'IMAGE', url: '/media?f=1', mime: 'image/jpeg', size: 1 },
        } as MessageDto,
        false,
      ),
    ).toBe('Nouveau message');
  });
});
