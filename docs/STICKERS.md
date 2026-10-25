# Ajouter des stickers illustrés

Les packs sont **embarqués dans l'application** : aucun service tiers, aucun téléchargement à l'exécution.

## Format des images

- **WebP**, **512 × 512 px**, fond **transparent**.
- Contour blanc d'environ **8 px** (effet « autocollant découpé »).
- **Moins de 80 Ko** par fichier.

## Dossier

```
mobile/assets/stickers/<pack>/<sticker>.webp
```

Exemple : `mobile/assets/stickers/mon-pack/bravo.webp`.

## Déclaration du pack

Dans `mobile/src/features/stickers/stickerPacks.ts`, ajoute un pack à `STICKER_PACKS` :

```ts
const MON_PACK: StickerPack = {
  id: 'mon-pack',                 // minuscules, chiffres et tirets
  name: 'Mon pack',
  iconEmoji: '😎',
  stickers: [
    {
      id: 'bravo',                // minuscules, chiffres, « _ » ou « - »
      kind: 'image',
      source: require('../../../assets/stickers/mon-pack/bravo.webp'),
      alt: 'Bravo',
    },
  ],
};

export const STICKER_PACKS: StickerPack[] = [MBOLO_PACK, MON_PACK];
```

La référence envoyée dans les messages est `pack/sticker` (ex. `mon-pack/bravo`) et doit respecter
`^[a-z0-9_-]{1,40}\/[a-z0-9_-]{1,60}$` — la même règle est validée par l'API.

## Diffusion

Un sticker n'apparaît chez les autres utilisateurs qu'après une **mise à jour de l'application** :
les packs sont livrés avec le binaire. Si la référence est inconnue, l'appli affiche le repli
« Sticker non disponible. Mets l'application à jour. ».
