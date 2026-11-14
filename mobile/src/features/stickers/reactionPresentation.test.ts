import { describe, expect, it } from 'vitest';

import { ALL_REACTIONS, QUICK_REACTIONS, reactionPresentation } from './reactionPresentation';

describe('présentation des réactions', () => {
  it('expose les six réactions rapides dans l’ordre demandé', () => {
    expect(QUICK_REACTIONS.map((reaction) => reaction.emoji)).toEqual([
      '👍',
      '❤️',
      '😂',
      '😮',
      '😢',
      '🙏',
    ]);
    expect(QUICK_REACTIONS.map((reaction) => reaction.ref)).toEqual([
      'mbolo-panther-2d/pouce-leve',
      'mbolo-panther-2d/amour',
      'mbolo-panther-2d/fou-rire',
      'mbolo-panther-2d/choc',
      'mbolo-panther-2d/tristesse',
      'mbolo-panther-2d/priere',
    ]);
  });

  it('garde la colère disponible derrière le bouton +', () => {
    expect(ALL_REACTIONS).toHaveLength(7);
    expect(QUICK_REACTIONS).not.toContainEqual(
      expect.objectContaining({ ref: 'mbolo-panther-2d/colere' }),
    );
    expect(reactionPresentation('mbolo-panther-2d/colere')).toMatchObject({
      emoji: '😠',
      label: 'En colère',
    });
  });

  it('ignore une réaction inconnue', () => {
    expect(reactionPresentation('emoji-libre')).toBeNull();
  });
});
