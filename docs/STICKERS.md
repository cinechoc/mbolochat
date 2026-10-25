# Stickers illustrés

Les packs sont **embarqués dans l'application** : aucun service tiers, aucun téléchargement
obligatoire à l'exécution.

## Sélecteur d'expressions

Le panneau est séparé en trois sections explicites :

- **Emojis** : recherche, récents, favoris et catégories Unicode (comportement historique).
- **Stickers** : recherche, Tous / Favoris / Récents / Mes stickers, création personnelle.
- **GIF** : GIF GIPHY déjà reçus ou envoyés dans la conversation, réutilisables tels quels.
  Aucun fournisseur externe n'est appelé : le serveur revalide seulement l'URL GIPHY existante.
  L'attribution « GIF via GIPHY » est affichée dans le panneau.

## Panthère Mbolo

Le pack visible est `mbolo-panther` : 26 illustrations originales de la mascotte panthère noire,
une par expression (bonjour, merci, amour, fou rire, pleurs, etc.).

- Fichiers : `mobile/assets/stickers/mbolo-panther/<sticker>.png`
- Métadonnées : `pantherCatalog.generated.ts` et `pantherAssets.generated.ts`
- Génération : `cd mobile && node scripts/generate-panther-stickers.mjs`

Le script dessine chaque pose en SVG (même visage, mêmes proportions, même palette), puis les
rasterise avec `sharp` en **PNG 512 × 512 à fond transparent**. Le rendu est volontairement 2D :
aplats, ombres et reflets dessinés, contours sombres, **sans halo ni contour blanc**. Les fichiers
sont optimisés en palette (environ 32 Ko chacun). Aucune image externe n'est utilisée.

Pour ajouter une expression : ajoute une entrée dans `STICKERS` (script), relance la génération,
puis vérifie que l'identifiant respecte la règle ci-dessous.

## Stickers personnels

- Création depuis la galerie avec recadrage carré, **aperçu avant enregistrement**, puis copie
  dans le dossier privé `document/stickers`.
- Métadonnées dans AsyncStorage (`mbolo.stickers.v1`), récents et favoris inclus. La clé est
  celle de l'ancien sélecteur : les créations déjà présentes sur l'appareil sont conservées.
- Un sticker personnel part comme une image importée avec les métadonnées `sticker`
  (aucun nouveau protocole) ; il réutilise la file d'envoi hors ligne.
- Appui long dans « Mes stickers » : ajouter/retirer des favoris ou supprimer le sticker.
- La déconnexion vide la bibliothèque personnelle et supprime les fichiers associés.

## Ajouter un sticker reçu aux favoris

Un appui long sur un sticker reçu propose « Ajouter aux favoris » ou « Retirer des favoris » :

- sticker de catalogue : la référence `mbolo-panther/*` est conservée ;
- sticker joint reçu : l'image est **téléchargée localement** dans le dossier privé puis ajoutée
  à « Mes stickers » et aux favoris. Un identifiant stable évite les doublons ; un téléchargement
  en échec n'ajoute rien.

Les favoris survivent au redémarrage et sont réutilisables dans n'importe quelle conversation.

## Format des images

- **PNG** (ou WebP), **512 × 512 px**, fond **transparent**.
- Contours sombres dessinés, sans bordure blanche automatique.
- **Moins de 100 Ko** par fichier.

## Dossier

```
mobile/assets/stickers/<pack>/<sticker>.png
```

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
      source: require('../../../assets/stickers/mon-pack/bravo.png'),
      alt: 'Bravo',
    },
  ],
};

export const STICKER_PACKS: StickerPack[] = [PANTHER_PACK, MON_PACK];
```

La référence envoyée dans les messages est `pack/sticker` (ex. `mbolo-panther/bonjour`) et doit
respecter `^[a-z0-9_-]{1,40}\/[a-z0-9_-]{1,60}$` — la même règle est validée par l'API.

## Compatibilité des anciens messages

L'ancien pack typographique `mbolo` n'apparaît plus dans le sélecteur, mais il reste dans
`LEGACY_STICKER_INDEX`. Les messages déjà persistés (par exemple `mbolo/merci`) continuent donc
d'afficher exactement la même carte qu'avant. Ne réutilise jamais un ancien identifiant pour une
nouvelle illustration : ajoute un nouvel identifiant dans le nouveau pack.

## Diffusion

Un sticker n'apparaît chez les autres utilisateurs qu'après une **mise à jour de l'application** :
les packs sont livrés avec le binaire. Si la référence est inconnue, l'appli affiche le repli
« Sticker non disponible. Mets l'application à jour. ».
