import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGiphyUrl, toPanelItem, GIPHY_BUNDLE, GIPHY_LANG, GIPHY_RATING } from '../src/lib/giphy.ts';

test('buildGiphyUrl : endpoint + paramètres du bundle messagerie', () => {
  const url = new URL(
    buildGiphyUrl({
      feed: 'stickers',
      mode: 'trending',
      apiKey: 'beta-key',
      limit: 24,
      offset: 0,
      customerId: 'user-1',
    }),
  );
  assert.equal(url.origin, 'https://api.giphy.com');
  assert.equal(url.pathname, '/v1/stickers/trending');
  assert.equal(url.searchParams.get('api_key'), 'beta-key');
  assert.equal(url.searchParams.get('bundle'), GIPHY_BUNDLE);
  assert.equal(url.searchParams.get('bundle'), 'messaging_non_clips');
  assert.equal(url.searchParams.get('lang'), 'fr');
  assert.equal(url.searchParams.get('lang'), GIPHY_LANG);
  assert.equal(url.searchParams.get('rating'), 'g');
  assert.equal(url.searchParams.get('rating'), GIPHY_RATING);
  assert.equal(url.searchParams.get('customer_id'), 'user-1');
  assert.equal(url.searchParams.get('limit'), '24');
  assert.equal(url.searchParams.get('offset'), '0');
  // Pas de recherche : pas de paramètre q (mode trending).
  assert.equal(url.searchParams.get('q'), null);
});

test('buildGiphyUrl : recherche encodée et plafonds imposés', () => {
  const url = new URL(
    buildGiphyUrl({
      feed: 'gifs',
      mode: 'search',
      apiKey: 'k',
      q: 'merci beaucoup!',
      limit: 120, // > max bêta
      offset: -5,
    }),
  );
  assert.equal(url.pathname, '/v1/gifs/search');
  // Recherche passée telle quelle, encodée par l'URL.
  assert.equal(url.searchParams.get('q'), 'merci beaucoup!');
  // Plafond bêta : 50 résultats au plus.
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(url.searchParams.get('offset'), '0');
});

test('toPanelItem : rendus webp préférés aux URLs GIF brutes', () => {
  const item = toPanelItem({
    id: 'abc123',
    title: 'Cat says hi ',
    username: 'lilcat',
    analytics: {
      onclick: { url: 'https://giphy-analytics.giphy.com/v2/pingback_simple?payload=e&type=CLICK' },
      onsent: { url: 'https://giphy-analytics.giphy.com/v2/pingback_simple?payload=e&type=SENT' },
    },
    images: {
      fixed_width_small: {
        url: 'https://media1.giphy.com/media/abc123/100w.gif',
        webp: 'https://media1.giphy.com/media/abc123/100w.webp',
        width: '100',
        height: '80',
      },
      fixed_width_small_still: { url: 'https://media1.giphy.com/media/abc123/100w_s.gif' },
      fixed_width: {
        url: 'https://media1.giphy.com/media/abc123/200w.gif',
        webp: 'https://media1.giphy.com/media/abc123/200w.webp',
        width: '200',
        height: '160',
      },
      fixed_width_still: { url: 'https://media1.giphy.com/media/abc123/200w_s.gif' },
    },
  });
  assert.ok(item);
  // WebP : transparence pour les stickers + poids réduit ; URL jamais altérée.
  assert.equal(item.gridUrl, 'https://media1.giphy.com/media/abc123/100w.webp');
  assert.equal(item.sendUrl, 'https://media1.giphy.com/media/abc123/200w.webp');
  assert.equal(item.gridWidth, 100);
  assert.equal(item.gridHeight, 80);
  assert.equal(item.sendWidth, 200);
  assert.equal(item.stillUrl, 'https://media1.giphy.com/media/abc123/200w_s.gif');
  assert.equal(item.username, 'lilcat');
  assert.equal(item.title, 'Cat says hi');
  assert.ok(item.onclick?.includes('type=CLICK'));
  assert.ok(item.onsent?.includes('type=SENT'));
});

test('toPanelItem : garde-fous de repli et objets inexploitables rejetés', () => {
  // Pas d'identifiant : on ne peut pas afficher ni référencer le GIF.
  assert.equal(toPanelItem({ images: {} }), null);
  // Aucun rendu de grille : on retire l'objet, sans réordonner les autres.
  assert.equal(toPanelItem({ id: 'x' }), null);
  // Sans rendu d'envoi : on retombe sur le rendu de grille.
  const fallback = toPanelItem({
    id: 'y',
    images: {
      fixed_width_small: {
        url: 'https://media0.giphy.com/media/y/100w.gif',
        width: '100',
        height: '70',
      },
    },
  });
  assert.ok(fallback);
  assert.equal(fallback.sendUrl, 'https://media0.giphy.com/media/y/100w.gif');
  assert.equal(fallback.sendWidth, 200); // 2× la grille, repli raisonnable
  assert.equal(fallback.gridHeight, 70);
  // URL d'aperçu non-HTTPS : refusée, pas d'aperçu du tout.
  const insecure = toPanelItem({
    id: 'z',
    images: {
      fixed_width_small: { url: 'https://media0.giphy.com/media/z/100w.gif' },
      fixed_width_still: { url: 'http://media0.giphy.com/media/z/200w_s.gif' },
    },
  });
  assert.ok(insecure);
  assert.equal(insecure.stillUrl, null);
});
