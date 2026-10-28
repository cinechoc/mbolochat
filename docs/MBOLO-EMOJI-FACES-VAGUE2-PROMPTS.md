# Prompts de génération — Visages Mbolo vague 2 (24 dessins)

Choix du 2026-10-27 : production par **génération d'images externe** (Midjourney, DALL-E,
Firefly, Flux…), branchement automatique ensuite par l'agent.

## Mode d'emploi

1. **Un prompt = une image = un fichier** (colonne « Prompt » ci-dessous, prêt à coller).
2. **Cohérence de style** : si l'outil accepte une image de référence, joindre
   `mobile/assets/stickers/mbolo-panther-2d/sourire.png` (Midjourney : `--sref <url>`,
   génération 1 par 1, pas de grille). Sinon, s'appuyer sur le bloc de style inclus
   dans chaque prompt et régénérer les ratés.
3. **Export** : PNG **transparent** si possible (512 px minimum). Si l'outil ne sort
   que fond blanc : l'indiquer à l'agent, un détourage automatique sera ajouté au pipeline.
4. Déposer les fichiers dans `mobile/assets/emoji-faces-src/` puis prévenir l'agent.

## Les 24 prompts

Chaque prompt suit ce gabarit — `ADORABLE KAWAII BLACK PANTHER CUB HEAD, 2D flat
illustration, soft airbrushed shading, bold dark outline, huge glossy amber-brown
eyes with large white catchlights, cream muzzle, pink nose, pink-cream inner ears,
subtle darker rosette spots on forehead, head and neck base only (no body, no paws),
centered, plain background, emoji sticker style` suivi de l'expression propre :

| # | Fichier cible | Expression à ajouter au gabarit |
| --- | --- | --- |
| 1 | `rieur.png` | wide open joyful grin, round sparkling eyes |
| 2 | `yeux-rieurs.png` | gently closed curved smiling eyes, soft warm smile |
| 3 | `sourire-goutte.png` | awkward embarrassed grin, single blue sweat drop on forehead |
| 4 | `clin-doeil.png` | winking one eye, smug friendly smile |
| 5 | `bisou.png` | *(déjà couvert — face-bisous ✓ ne pas regénérer)* |
| 6 | `pleure.png` | sad expression, single blue tear under one eye, drooping eyebrows |
| 7 | `pensif.png` | downcast eyes, sad eyebrows, small sad frown |
| 8 | `blase.png` | unimpressed half-lidded narrow eyes, flat straight mouth |
| 9 | `boudeur.png` | deep frown, furrowed angry eyebrows, pinched pouting mouth |
| 10 | `fumee-narines.png` | angry frown, white steam puffs blowing from both nostrils |
| 11 | `lunettes-soleil.png` | wearing black sunglasses, confident cool smile |
| 12 | `roulade-rire.png` | head tilted back, laughing extremely hard, big blue laughing tears |
| 13 | `etoiles-yeux.png` | bright yellow stars replacing the eyes, amazed open smile |
| 14 | `coeurs-sourire.png` | smiling curved closed eyes, three small red hearts floating around the head |
| 15 | `grimace.png` | gritted teeth grimace, wide startled eyes |
| 16 | `chaud.png` | overheated red-tinted face, sweat beads, tongue sticking out |
| 17 | `anxieux.png` | worried trembling expression, single blue sweat drop near the head |
| 18 | `masque.png` | wearing a plain white medical mask over the muzzle, tired eyes |
| 19 | `nausee.png` | queasy green-tinted face, puffed cheeks, wavy frown |
| 20 | `cable.png` | open warm smile with two small raised paws hugging at the sides of the face |
| 21 | `explose.png` | top of skull open with a bright comic explosion burst above |
| 22 | `yeux-roules.png` | eyes rolled upward showing mostly whites, flat annoyed mouth |
| 23 | `epuise.png` | exhausted drooping closed eyes, sagging open mouth |
| 24 | `argent-yeux.png` | golden coins replacing the eyes, dollar bills floating, tongue out |

## Exemple assemblé (prompt 1)

```
Adorable kawaii black panther cub head, 2D flat illustration, soft airbrushed
shading, bold dark outline, huge glossy amber-brown eyes with large white
catchlights, cream muzzle, pink nose, pink-cream inner ears, subtle darker
rosette spots on forehead, wide open joyful grin, round sparkling eyes, head
and neck base only (no body, no paws), centered, plain background, emoji
sticker style
```

## Dérivations prévues (sans dessin supplémentaire)

Les déclinaisons listées dans `MBOLO-EMOJI-FACES-VAGUE2-BRIEF.csv` (colonne
`derive_vers`) partagent le socle du dessin : l'agent les recadre/travaille depuis
le même fichier (yeux différents = second dessin léger du même socle, à cadrer
dans la même image si possible ou en retouche légère).
