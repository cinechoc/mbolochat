# Sources des visages Mbolo (Vague 2+)

Ce dossier reçoit les **dessins neufs** des visages de réaction (tête seule), produits
en dehors de cet environnement (designer ou outil de génération d'images).

## Spec

- PNG **512 × 512**, fond transparent, sans halo ni dégradé de fond.
- Style identique à `assets/stickers/mbolo-panther-2d/` : panthère noire 2D,
  même épaisseur de trait, mêmes couleurs de fourrure (noir + museau crème).
- **Contenu : tête + socle de cou uniquement** — pas de pattes, pas de corps.
- Détails sémantiques flottants acceptés et souhaités : larmes, goutte de sueur,
  Zzz, « ? », cœur, vapeur (ils sont protégés au recadrage via `rect_zones`).
- Nommage : kebab-case, correspondre aux fichiers listés dans
  `docs/MBOLO-EMOJI-FACES-VAGUE2-BRIEF.csv` (colonne `fichier`).

## Branchement (fait par l'agent, pas à la main)

1. Entrée dans `mobile/scripts/mbolo-emoji-face-sources.json` avec
   `"dir": "assets/emoji-faces-src"`.
2. `OPTIONS` dans `mobile/scripts/build-mbolo-emoji-faces.py` si cadrage particulier.
3. `python3 scripts/build-mbolo-emoji-faces.py` → WebP 96/192 dans `assets/emoji-faces/`.
4. `npm run gen:mbolo-emoji` → registre + docs.
5. `node --test tests/mboloEmojiFaces.test.mjs …` + `npx tsc --noEmit` + `npx expo lint`.
6. Publication : `npx eas update` (aucun build natif).
