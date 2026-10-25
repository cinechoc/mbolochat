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

Le pack visible est `mbolo-panther-2d` : 30 illustrations originales de la mascotte panthère noire,
une par expression (bonjour, salut, au revoir, merci, s'il te plaît, OK, oui, non, amour, bisous,
câlin, je t'aime, fou rire, petit sourire, tristesse, gros chagrin, colère, surprise, choc,
timidité, réflexion, confusion, fatigue, sommeil, bonne nuit, fête, bravo, courage, pouce levé,
yeux en cœur).

- Référence de style : `mobile/assets/stickers/reference/panthere-reference.png`
- Fichiers : `mobile/assets/stickers/mbolo-panther-2d/<sticker>.png`
- Métadonnées : `panther2dCatalog.generated.ts` et `panther2dAssets.generated.ts`
- Enregistrement du catalogue : `cd mobile && node scripts/generate-panther-2d-catalog.mjs`

Les illustrations sont peintes en 2D avec le même personnage, le même visage, les mêmes
proportions et la même palette que la référence. Chaque fichier est un **PNG 512 × 512 à vrai canal
alpha** (coins transparents, marges de 20 px), détouré et defringué par
`prepare-sticker-image.mjs`, puis optimisé en palette (**moins de 100 Ko** chacun). Le fond, l'ombre
au sol et les poches de fond résiduelles sont retirés ; chaque fichier est contrôlé sur fond clair
et sombre. Aucune bordure blanche automatique n'est ajoutée.

Pour ajouter une expression : génère l'illustration sur fond blanc uniforme, passe-la dans
`node scripts/prepare-sticker-image.mjs <entrée.png> <sortie.png>`, vérifie le résultat sur fond
clair et sombre (ombres et poches de fond éventuelles), ajoute l'entrée dans
`scripts/generate-panther-2d-catalog.mjs`, relance l'enregistrement du catalogue, puis vérifie
l'identifiant avec la règle ci-dessous.

Le pack historique `mbolo-panther` (26 illustrations) n'est plus proposé dans le sélecteur, mais
reste livré pour les anciens messages (voir « Compatibilité des anciens messages »).

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

- sticker de catalogue : la référence `mbolo-panther-2d/*` est conservée ;
- sticker joint reçu : l'image est **téléchargée localement** dans le dossier privé puis ajoutée
  à « Mes stickers » et aux favoris. Un identifiant stable évite les doublons ; un téléchargement
  en échec n'ajoute rien.

Les favoris existants qui pointent vers l'ancien pack `mbolo-panther/*` restent résolus et
conservent leur illustration d'origine. Les nouveaux favoris utilisent `mbolo-panther-2d/*`.

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

export const STICKER_PACKS: StickerPack[] = [PANTHER_2D_PACK, MON_PACK];
```

La référence envoyée dans les messages est `pack/sticker` (ex. `mbolo-panther-2d/bonjour`) et doit
respecter `^[a-z0-9_-]{1,40}\/[a-z0-9_-]{1,60}$` — la même règle est validée par l'API.

## Compatibilité des anciens messages

L'ancien pack typographique `mbolo` et l'ancien pack illustré `mbolo-panther` n'apparaissent plus
dans le sélecteur, mais ils restent dans `LEGACY_STICKER_INDEX`. Les messages déjà persistés
(par exemple `mbolo/merci` ou `mbolo-panther/bonjour`) continuent donc d'afficher exactement la
même carte qu'avant. Ne réutilise jamais un ancien identifiant pour une nouvelle illustration :
ajoute un nouvel identifiant dans le nouveau pack.

## Diffusion

Un sticker n'apparaît chez les autres utilisateurs qu'après une **mise à jour de l'application** :
les packs sont livrés avec le binaire. Si la référence est inconnue, l'appli affiche le repli
« Sticker non disponible. Mets l'application à jour. ».
