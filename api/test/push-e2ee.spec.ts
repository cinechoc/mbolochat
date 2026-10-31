import { describe, expect, it } from 'vitest';

import { notificationSummary } from '../src/push/push.service.js';

const conversation = { type: 'GROUP' as const, name: 'Les amis', emoji: '🎉' };
const message = {
  type: 'text',
  content: 'texte en clair interdit',
  attachment: null,
  sender: { displayName: 'Alice' },
};

describe('push E2EE', () => {
  it('ne révèle ni expéditeur ni contenu pour une enveloppe chiffrée', () => {
    expect(
      notificationSummary({ ...message, encryption: 'v1' }, conversation, true),
    ).toEqual({
      encrypted: true,
      title: 'MboloChat',
      text: 'Nouveau message',
      body: 'Nouveau message',
    });
  });

  it('garde le comportement historique pour les messages en clair', () => {
    const summary = notificationSummary({ ...message, encryption: 'none' }, conversation, true);
    expect(summary.encrypted).toBe(false);
    expect(summary.body).toContain('Alice');
    expect(summary.body).toContain('texte en clair interdit');
  });
});
