import { describe, expect, it } from 'vitest';

import { parseFormattedText, stripFormatting } from './text-format';

describe('parseFormattedText', () => {
  it('reconnaît les quatre mises en forme demandées', () => {
    expect(parseFormattedText('**gras** *italique* ~barré~ `mono`')).toEqual([
      { text: 'gras', bold: true },
      { text: ' ' },
      { text: 'italique', italic: true },
      { text: ' ' },
      { text: 'barré', strike: true },
      { text: ' ' },
      { text: 'mono', mono: true },
    ]);
  });

  it('garde les délimiteurs non fermés comme texte normal', () => {
    expect(parseFormattedText('**pas fermé')).toEqual([{ text: '**pas fermé' }]);
    expect(parseFormattedText('un * seul')).toEqual([{ text: 'un * seul' }]);
  });

  it('accepte les échappements et les styles imbriqués', () => {
    expect(parseFormattedText('\\*littéral\\*')).toEqual([{ text: '*littéral*' }]);
    expect(parseFormattedText('**gras *aussi***')).toEqual([
      { text: 'gras ', bold: true },
      { text: 'aussi', bold: true, italic: true },
    ]);
  });

  it('ne réinterprète pas le Markdown à l’intérieur du code', () => {
    expect(parseFormattedText('`**brut**`')).toEqual([{ text: '**brut**', mono: true }]);
  });
});

describe('stripFormatting', () => {
  it('rend le texte brut destiné aux compteurs', () => {
    expect(stripFormatting('**salut** ~les~ *amis*')).toBe('salut les amis');
  });
});
