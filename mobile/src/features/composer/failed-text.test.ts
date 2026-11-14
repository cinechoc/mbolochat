import { describe, expect, it } from 'vitest';

import { restoreFailedText } from './failed-text';

describe('restoreFailedText', () => {
  it('remet le texte échoué quand la zone est vide', () => {
    expect(restoreFailedText('', 'message perdu')).toBe('message perdu');
  });

  it('traite une zone contenant seulement des espaces comme vide', () => {
    expect(restoreFailedText('   ', 'message perdu')).toBe('message perdu');
  });

  it('ajoute le texte échoué à la saisie commencée entre-temps', () => {
    expect(restoreFailedText('nouveau brouillon', 'message perdu')).toBe(
      'nouveau brouillon\nmessage perdu',
    );
  });
});
