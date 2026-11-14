import { describe, expect, it } from 'vitest';

import {
  fallbackLinkPreview,
  firstHttpUrl,
  mergeLinkPreview,
  parseHtmlLinkPreview,
} from './link-preview';

describe('firstHttpUrl', () => {
  it('extrait la première URL et enlève la ponctuation finale', () => {
    expect(firstHttpUrl('Regarde https://example.com/article).')).toBe(
      'https://example.com/article',
    );
  });

  it('ignore les protocoles non http', () => {
    expect(firstHttpUrl('javascript:alert(1)')).toBeNull();
    expect(firstHttpUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('fallbackLinkPreview', () => {
  it('produit une carte exploitable avant le réseau', () => {
    expect(fallbackLinkPreview('https://www.example.com/mon-article')).toMatchObject({
      host: 'example.com',
      title: 'mon article',
      imageUrl: 'https://www.example.com/favicon.ico',
    });
  });
});

describe('parseHtmlLinkPreview', () => {
  it('lit Open Graph, description et image relative', () => {
    const html = `
      <html><head>
        <title>Repli</title>
        <meta property="og:title" content="Titre &amp; aperçu" />
        <meta name="description" content="Une description courte." />
        <meta property="og:image" content="/cover.jpg" />
      </head></html>`;
    expect(parseHtmlLinkPreview(html, 'https://example.com/page')).toEqual({
      title: 'Titre & aperçu',
      description: 'Une description courte.',
      imageUrl: 'https://example.com/cover.jpg',
    });
  });

  it('retombe sur la balise title quand Open Graph manque', () => {
    expect(parseHtmlLinkPreview('<title>Bonjour</title>', 'https://example.com')).toEqual({
      title: 'Bonjour',
      imageUrl: null,
    });
  });

  it('refuse une source invalide', () => {
    expect(parseHtmlLinkPreview('<title>x</title>', 'pas une url')).toBeNull();
  });
});

describe('mergeLinkPreview', () => {
  it('conserve les valeurs de repli si le réseau ne fournit rien', () => {
    const base = fallbackLinkPreview('https://example.com/page')!;
    expect(mergeLinkPreview(base, {})).toEqual(base);
  });
});
