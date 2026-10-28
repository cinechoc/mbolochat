# Plan de production des visages Mbolo — les visages en repli Unicode

Source : `docs/MBOLO-EMOJI-FACES-MISSING.csv` (86 visages humanoïdes en `unicode-fallback`),
`docs/MBOLO-EMOJI-FACES.csv` (suivi des 132), pipeline `mobile/scripts/build-mbolo-emoji-faces.py`.

## État courant (2026-10-27, après la Vague 2)

- 26/132 visages illustrés (portraits tête-seule validés, style étape 1B).
- 86 en repli Unicode : `MBOLO-EMOJI-FACES-MISSING.csv` (81 bases + 5 ZWJ… colonne `variante`).
- 20 hors périmètre étape 1 (costume/chat/singe) : traités dans une vague séparée en dernier.
- Contrainte machine : les **recadrages dérivés** se font ici (PIL, léger). Les **nouveaux dessins**
  doivent être produits en dehors (designer / autre environnement) puis branchés.

## Basis de priorisation

1. **Ordre CLDR/emojibase** (`order` du catalogue `gen-emoji-catalog.mjs`) comme proxy de fréquence
   d'usage — approximation, à affiner plus tard avec les « récents » de l'app.
2. **Coût de production** : dérivé de sticker existant (0 dessin) < dessin de base (1 nouveau)
   < déclinaison de famille (+ détails) < ZWJ (compose 2 éléments).

## Vague 0 — Validation du style (bloquant) — **VALIDÉE le 2026-10-27**

Recadrages tête seule approuvés. La production peut être généralisée par vagues.

## Vague 1 — Recadrages immédiats, zéro dessin (~4 à 6 emojis) — **FAIT + VALIDÉ (2026-10-27)**

3 portraits produits par recadrage des stickers existants, sans nouveau dessin :

| Portrait | Source | Emojis couverts | Méthode |
| --- | --- | --- | --- |
| `face-bisous` | `bisous` | 😘 `1f618` | recadrage + fondu, cœur flottant conservé (sémantique) |
| `face-fete` | `fete` | 🥳 `1f973` | masque polygonal (pattes levées et confettis retirés, chapeau + sourire conservés) |
| `face-confusion` | `confusion` | 😕 `1f615` | recadrage + fondu, « ? » flottants conservés (sémantique) |

Le script `build-mbolo-emoji-faces.py` accepte désormais `taper_start`/`taper_span`
paramétrables (mentons plus bas que le cadrage standard).

**En attente : validation visuelle** de ces 3 portraits (Vague 0 = validation des 12
existants + ceux-ci). Les stickers `sil-te-plait` et `calin` restent écartés : leur sens
(demande, câlin) est porté par le corps, pas la tête.

Méthode : ajouter les ids dans `mbolo-emoji-face-sources.json` + `OPTIONS` si la tête sort du
cadrage standard (modèle `face-choc`/`face-endormi`), puis `python3 scripts/build-mbolo-emoji-faces.py`.
Pas de build natif : livraison via `eas update`.

## Vague 2 — Top fréquence (~24 dessins, ~35 emojis couverts)

### Brief de production (pour le dessin externe)

- **Dossier de dépôt** : `mobile/assets/emoji-faces-src/` (créé à la première livraison).
- **Format** : PNG 512 × 512, fond transparent, même style que `assets/stickers/mbolo-panther-2d/`
  (panthère noire 2D, même épaisseur de trait, sans halo ni fond).
- **Contenu** : tête + socle de cou seulement — pas de pattes, pas de corps. Les détails
  sémantiques flottants sont les bienvenus (larmes, goutte de sueur, Zzz, « ? », cœur).
- **Nommage** : kebab-case (`<expression>.png`), un fichier par concept ci-dessous.
- **Branchement** (automatique de mon côté) : entrée dans `mbolo-emoji-face-sources.json`
  avec `"dir": "assets/emoji-faces-src"`, `OPTIONS` si besoin, puis `build-mbolo-emoji-faces.py`
  → `gen:mbolo-emoji` → tests → OTA `eas update`.
- **Sourcing initial (2026-10-27)** : génération IA externe — prompts prêts à coller dans
  `docs/MBOLO-EMOJI-FACES-VAGUE2-PROMPTS.md` (24 prompts, style ancré sur la panthère 2D).
- **Sourcing réel utilisé** : la planche de référence de l'utilisateur
  (`mobile/assets/reference/reference.JPG`, grille 4×4 de cellules 512 px) — 11 visages extraits
  par le code (détourage floodfill + recadrage tête seule), branchés le 2026-10-27.

### Liste prioritaire (ordre de fréquence CLDR)

| # | Fichier à dessiner | Emoji principal | Dérivations possibles |
| --- | --- | --- | --- |
| 1 | `rieur` | 😀 `1f600` | 😃 😁 😆 (yeux différents) |
| 2 | `yeux-rieurs-sourire` | 😊 fait ✓ (planche réf.) | ☺️ |
| 3 | `sourire-goutte` | 😅 fait ✓ (planche réf.) | (goutte = même détail que `face-fatigue`) |
| 4 | `clin-doeil` | 😉 `1f609` | 😜 😝 😋 fait ✓ (planche réf.) |
| 5 | `bisou` | 😘 fait ✓ | 😗 fait ✓ (planche réf.) ; 😚 😙 (yeux fermés/rieurs) |
| 6 | `pleure` | 😢 `1f622` | 🥲 (sourire + larme) |
| 7 | `pensif` | 😔 `1f614` | 🙁 😟 |
| 8 | `blase` | 😒 fait ✓ (planche réf.) | 😑 😐 😏 |
| 9 | `boudeur` | 😡 fait ✓ (planche réf.) | (même famille que `face-colere` 😠) |
| 10 | `fumee-narines` | 😤 `1f624` | — |
| 11 | `lunettes-soleil` | 😎 `1f60e` | 🤓 🧐 (lunettes différentes) |
| 12 | `roulade-rire` | 🤣 `1f923` | (socle `face-fou-rire` ✓) |
| 13 | `etoiles-yeux` | 🤩 `1f929` | (mécanique des yeux-en-cœur ✓) |
| 14 | `coeurs-sourire` | 🥰 `1f970` | — |
| 15 | `grimace` | 😬 `1f62c` | — |
| 16 | `chaud` | 🥵 `1f975` | 🥶 (même tête, teinte froide) |
| 17 | `anxieux` | 😰 `1f630` | 😨 😧 (famille peur, socle `face-choc` ✓) |
| 18 | `masque` | 😷 `1f637` | 🤒 🤕 (thermomètre / bandage) |
| 19 | `nausee` | 🤢 `1f922` | 🤮 🤧 |
| 20 | `cable` | 🤗 fait ✓ (planche réf.) | (bras : exception validée tête+patte) |
| 21 | `explose` | 🤯 `1f92f` | — |
| 22 | `yeux-roules` | 🙄 `1f644` | — |
| 23 | `epuise` | 😩 `1f629` | 😫 ; 🥱 fait ✓ (planche réf.) |
| 24 | `argent-yeux` | 🤑 `1f911` | — |

Critère : un socle dessiné sert idéalement 2–4 emojis → ~24 dessins pour ~35 visages.

### Bilan de la vague (2026-10-27) — 11 visages branchés

Faits par extraction de la planche de référence de l'utilisateur (détourage + recadrage tête
seule, tests 46/46, typecheck + lint OK) : 😊 😅 😲 🥱 🤨 😋 😡 😒 😗 😌 🤗 →
portraits `face-yeux-rieurs`, `face-pardon`, `face-stupefait`, `face-baillement`,
`face-quoi`, `face-miam`, `face-grrr`, `face-bof`, `face-bisou-leger`, `face-chill`,
`face-calin-ouvert` (certaines dérivations du tableau ci-dessus sont donc déjà couvertes).

- 🥰 `coeurs-sourire` **reporté** : sur la planche, les cœurs sont fusionnés au corps
  (queue) — extraction tête-seule impossible sans retouche dessin.
- Le reste de la liste reste « à dessiner » ; les prompts IA de
  `docs/MBOLO-EMOJI-FACES-VAGUE2-PROMPTS.md` restent utilisables.
- **Point de style à valider** : les visages issus de la planche (yeux/têtes plus grandes)
  cohabitent avec les recadrages stickers `mbolo-panther-2d` — à arbitrer visuellement
  par l'utilisateur dans l'app.

## Vague 3 — Familles restantes (~50)

Par sous-groupe Unicode, un socle par famille :

- faim/miam : 🤤 🤑
- main sur bouche : 🤭 🫢 🤫 🤐 (2 socles, variations de patte)
- salut militaire, monocle, geek, casquette : lunettes/chapeaux → dérivés du socle neutre
- déçoit/perplexe : 🫤 🙄 (fait vague 2) 🧐
- souffle/ZWJ simples : 😮‍💨 (socle surprise existant + souffle)
- malades finis : 🤮 🤧 😵 🫩
- fusées rares : 🫠 🫥 🫨 🫪 🫫 🥹 🫩 (spec 15+ — garder en fin de vague)

## Vague 4 — ZWJ + costume/chat/singe (dernier)

- 😶‍🌫️ 🙂‍↔️ 🙂‍↕️ 😵‍💫 😮‍💨 si non traité : composés 2 éléments, coût le plus élevé par emoji.
- 20 visages costume/chat/singe : la règle tête-seule se prête bien (têtes déjà distinctes),
  mais hors étape 1 par décision projet.

## Vague 2B — Expressions procédurales (2026-10-27)

Le générateur d'images étant bloqué (HTTP 403), les expressions manquantes ont été
**codées paramétriquement** plutôt que dessinées à la main :

- Script : `mobile/scripts/build-mbolo-emoji-proc.py` + spec
  `mobile/scripts/mbolo-emoji-proc-spec.json`.
- Socle : tête de `assets/emoji-faces-src/wow.png` (yeux/bouche effacés par clonage
  de fourrure), traits redessinés en PIL (8 types d'yeux, 3 sourcils, 12 bouches,
  18 accessoires, teintes HSV sur fourrure seule, rotation).
- Sortie : `assets/emoji-faces-proc/<id>.png` (512 px) → pipeline habituel via
  `PROC_DEFAULT` (cadrage tête seule commun) dans `build-mbolo-emoji-faces.py`.
- Résultat : **61 portraits procéduraux** branchés, 91/112 visages humanoïdes
  illustrés, 21 restants (costume, ZWJ, formes dédiées : 🤣 🤯 🥸 🤠  🫥 🫨 🫪 🫩 🫡…).

## Vague 2C — Formes dédiées (2026-10-27)

18 visages supplémentaires codés dans le même générateur procédural, avec de nouveaux
accessoires/formes : cornes (😈 👿), auréole (😇), patte de salut (🫡), contour pointillé
(🫥), nuage (😶‍🌫️), nez long (🤥), traits de secousse (🫨 🙂‍↔️ 🙂‍↕️), cernes (🫩),
larmes (🤣), explosion (🤯), chapeau (🤠), déguisement (🥸), fonte (🫠), rotation (🫪).
☺️ partage l'art de 😊 (`face-yeux-rieurs`).

État final : **110/112 visages humanoïdes illustrés**, 123 emojis illustrés au total.
Restent 💀 ☠️ — non-humains, hors règle tête-seule (à traiter dans une vague dédiée si souhaité).

## Processus par vague (identique à l'étape 1B)

1. Dessins source ajoutés dans `assets/stickers/mbolo-panther-2d/` (ou dossier dédié) par la
   production externe — l'environnement actuel renvoie HTTP 403 au générateur d'images.
2. Déclaration dans `mobile/scripts/mbolo-emoji-face-sources.json` (+ `OPTIONS` du script
   pour cadrages/patrouilles particuliers).
3. `python3 scripts/build-mbolo-emoji-faces.py` → WebP 96/192 dans `assets/emoji-faces/`.
4. Mise à jour du registre (`npm run gen:mbolo-emoji`) → `EMOJI_SOURCES`.
5. Vérifications `node --test tests/mboloEmojiFaces.test.mjs …` + `npx tsc --noEmit` +
   `npx expo lint` (légères, possibles sur cette machine).
6. Livraison OTA : `npx eas update` — **aucun build natif requis** tant qu'aucune nouvelle
   dépendance native n'est introduite.

## Règles de cadrage à conserver (étape 1B)

Contenu (tête+socle ou détail sémantique) à 86 % de la largeur, bas ancré à 83 %, centre
horizontal ; détails porteurs de sens conservés (larmes, goutte, Zzz, patte, rougissement).
Tête-seule obligatoire : pas de sticker complet utilisé comme emoji.
