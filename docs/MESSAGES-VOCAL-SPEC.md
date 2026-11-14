# Messages vocaux — ergonomie Snapchat, aperçu, lecture unique et transcription

Ce document fige le contrat du lot « messages vocaux » (Section 2 du cahier des
charges). Il s'appuie sur la base existante (`expo-audio`, onde par mesure de
niveau, lecteur unique de l'app, chemin média v:2) et n'y ajoute que ce qui est
décrit ici. Le serveur ne reçoit jamais le texte d'un transcript, ni une clé,
ni le contenu d'un média chiffré.

## 1. Gestes d'enregistrement (`voice-gesture.ts`)

La machine à états est pure et testée ; le composant ne branche que les effets
natifs (capture, haptique, rendu).

- **Appui long** (`LONG_PRESS_MS = 300`) : la capture démarre quand le seuil est
  atteint. Un tap court ne fait rien (haptique seule).
- **Glissement à gauche** (`dx ≤ -SLIDE_TRIGGER_PX = -60` sur l'axe dominant) :
  zone d'annulation — poubelle animée, message « Relâcher pour annuler » ;
  relâcher jette la note.
- **Glissement vers le haut** (`dy ≤ -60`) : zone de verrouillage — relâcher
  passe en mains libres, la capture continue.
- **Relâchement sans zone** : envoi immédiat.
- Le toucher repris par le système (`terminate`) annule, même hors zone.
- Pendant l'enregistrement, le champ affiche le chronomètre, l'onde live et,
  tant que le doigt est posé, les deux indices : « Glisser à gauche pour
  annuler 🗑️ » et « Glisser vers le haut pour verrouiller 🔒 ».
- Une note sous `MIN_DURATION_MS = 1000` est jetée (« Message trop court ») ;
  à `MAX_DURATION_MS = 60 000`, la note est **capturée mais jamais envoyée en
  douce** : l'appelant décide (envoi direct si le doigt est encore posé, aperçu
  si l'enregistrement était verrouillé).

## 2. Mode verrouillé et mode aperçu

- **Verrouillé** (doigt relevé) : le chronomètre et l'onde continuent, le
  clavier est masqué, un bouton 🛑 arrête la capture.
- **Aperçu** (après stop) : la barre affiche 🗑️ Supprimer, un mini lecteur
  (play/pause, onde statique de la note, durée restante), la bascule « 1 »
  cerclé (lecture unique) et le bouton d'envoi ➤. Le lecteur partage l'unique
  lecteur audio de l'app : écouter l'aperçu coupe toute lecture de bulle.
- 🗑️ supprime le fichier local et revient au champ de saisie ; ➤ envoie la note
  avec ou sans lecture unique.

## 3. Lecture unique vocale

### Chiffré — enveloppe `v:9`

```json
{
  "v": 9,
  "kind": "media",
  "media": { "type": "AUDIO", "mime": "audio/mp4", "duration": 3200, "waveform": [/* 0..1 */], "blob": { "uploadId": "…", "fileKey": "…", "nonce": "…", "sha256": "…", "size": 1234 } },
  "caption": "",
  "viewOnce": true
}
```

- Clés exactes à la lecture (`v`, `kind`, `media`, `caption`, `replyTo` et
  `viewOnce` facultatifs) : tout champ interdit, supplémentaire ou mal typé
  rend le contenu illisible (`invalid_payload`), comme pour `v:8`.
- `viewOnce` n'a qu'une valeur admise : `true`.
- `v:1` à `v:8` restent inchangés ; les fixtures « version future » des tests
  passent à `v:10`.
- À l'envoi, la ligne provisoire SQLCipher porte déjà `view_once` : une
  reprise après coupure reconstruit l'enveloppe en `v:9` avec le même drapeau.
- À la réception, un média `v:9` est marqué `view_once` comme le texte `v:8`.
- Ouverture : la modale de lecture unique déchiffre (`openForView`), joue une
  fois, et efface le clair à la fermeture ; `consumeViewOnce` purge la copie
  locale et masque celle du pair.

### Clair — chemin outbox

- `viewOnce` passe par la file (colonne existante) jusqu'au serveur, qui le
  stocke sur le message ; l'interface le masque derrière son voile, comme le
  texte.
- La **forme d'onde** du vocal est une métadonnée d'affichage du chemin clair :
  le gateway l'accepte sur `message:send` (au plus 40 valeurs finies dans
  `[0,1]`, sinon `Forme d'onde invalide`) et la fusionne à la pièce jointe
  `AUDIO` — jamais pour un média chiffré, où elle voyage dans l'enveloppe.

## 4. Bulle vocale

- Géométrie WeChat conservée (asymétrie + ergot) ; la bulle s'élargit ou
  rétrécit selon la durée.
- Lecture : play/pause, onde colorée de gauche à droite selon la progression,
  durée totale puis restante pendant la lecture, scrub-to-seek conservé.
- **Vitesse** : puce dans la bulle, toujours visible, « 1x » par défaut, cycles
  1x → 1,5x → 2x, mémorisée (AsyncStorage) et appliquée avec correction de
  hauteur (`shouldCorrectPitch`).
- **Transcription** : bouton « Aa » uniquement sur les bulles vocales **reçues
  chiffrées**, dont le clair est déchiffré et dont un moteur est enregistré.
  Le texte s'affiche sous l'onde, dans la bulle.

## 5. Transcription locale (`transcription.ts`)

- Moteur branchable : `setVoiceTranscriber(engine | null)`. Aucun moteur
  natif n'est livré dans ce lot — il viendra avec le lot natif (rebuild EAS) ;
  l'interface masque le bouton tant que le registre est vide.
- Orchestration : cache d'abord (un transcript déjà produit reste lisible même
  sans moteur), moteur ensuite, normalisation (`trim`, borne
  `MAX_TRANSCRIPTION_LENGTH = 5 000` avec ellipse), sauvegarde seulement si un
  texte existe.
- Cache : table SQLCipher `e2ee_voice_transcriptions(message_id, text,
  created_at)` (migration v13). Rien en clair, rien côté serveur.
- Sans parole reconnue ou en cas d'échec moteur : « Transcription indisponible
  », rien n'est stocké.

## 6. Vérifications

- Mobile : `npx tsc --noEmit`, `npx expo lint`, `npm test` (Vitest ;
  `voice-gesture`, `payload` v:9, `classic-transport` outbox, `transcription`,
  schéma v13).
- API : `npx tsc --noEmit`, `npm run lint`, `npm test`.
- Sur appareil (de votre côté) : gestes, verrouillage, aperçu, lecture unique
  aller-retour entre deux comptes, clair et chiffré, puis audit canari
  (`docs/audit-e2ee/M3-MEDIA.md`).
