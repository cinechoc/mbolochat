MBOLOCHAT — PLAN DE FUSION DES ÉCRANS DE CONVERSATION

Version 1.0 — PHASE 1 (analyse comparative, aucun code de fusion modifié)
Date : 2026-11-09 — Base : `edee675` + modifications non commitées de la première mission (CORS, accessibilité, plan directeur).

Méthode : lecture des deux écrans complets, de leurs composants partagés, des points d'entrée de routage et des dépendances backend. Aucune fonctionnalité n'a été inventée ; chaque ligne du tableau renvoie au code lu.

---

## 1. Architecture actuelle des deux écrans

### 1.1 `mobile/src/app/chat/[id].tsx` — écran classique (3 354 lignes)

Rôle : conversation historique en clair (1:1 et groupes). Garde d'entrée : si la conversation est E2EE (`isE2eeEnabled() && conversation.e2eeSince`), redirection vers `/e2ee-chat/[id]` (`:2586-2612`) ou écran « bloqué » si le pair est introuvable. `sendText/sendSticker` refusent en plus tout envoi en clair vers une conversation protégée (`fr.e2eeChat.meetsInEncryptedScreen`, `:2462,2486`).

Pipeline : 100 % outbox SQLite (`mobile/src/lib/outbox.ts`, `clientId` idempotent) — texte, sticker, GIF, médias, vocal passent tous par `enqueue+drain` ; jamais d'envoi socket direct. Historique : `GET /conversations/:id/messages?limit=30` + pagination `before/after` (`onEndReached`), cache local immédiat, rattrapage hors ligne `GET /conversations/sync?since=`. Accusés : coches `Ticks` + `receipt` temps réel + « Vu par N » en groupe. Présence/typing : `presenceStore` (DIRECT) + événement `typing` avec texte (désactivé si le drapeau E2EE est actif, `:601-607`). Groupes : événements `group:updated`/`members:changed`/`conversation:removed`, rôles, permissions d'envoi (`whoCanSend`), mentions `@`. Appels : boutons dans l'en-tête (DIRECT et GROUP) via `CallProvider`.

### 1.2 `mobile/src/app/e2ee-chat/[id].tsx` — écran chiffré (1 578 lignes)

Rôle : discussion directe chiffrée de bout en bout (1:1 uniquement, `type:'DIRECT'` forcé `:639`). Entrée : `chatRouteFor()` (`mobile/src/features/e2ee/routing.ts:58-83`) ne choisit cette route que si `e2eeSince` est posé côté serveur **et** un pair unique est identifiable ; sinon refus (`blocked`), jamais de repli clair. L'écran synthétise une `ConversationSummary` minimale (`:637-681`) — le serveur reste autorité.

Pipeline : SQLCipher (`mbolo-e2ee.db`, `features/e2ee/db.ts`), ratchet Olm (vodozemac), envoi **direct par socket** `message:send {content:'', encryption:'v1', payload, payloadType, clientId}` (`text.ts:371-379`) — pas d'outbox classique (différence assumée, AGENTS.md). Historique : 200 derniers messages locaux SQLCipher + 50 derniers serveur au premier chargement (`:392-400`), **sans pagination**. Accusés « Reçu »/« Ouvert » : règles de visibilité réelle (viewport 50 % + 400 ms, `read-visibility.ts`), « Reçu » suit la présence du pair. `FLAG_SECURE` sur l'écran, brouillons en SQLCipher, médias chiffrés STREAM avec vignette chiffrée à clé séparée, clairs balayés.

### 1.3 Composants partagés (déjà communs aux deux écrans)

- `ChatBubble`, `MessageText`/`EmojiText`, `SingleEmojiMessage`, `ChatDateSeparator`/`ChatTimeSeparator`, `ChatEmptyState`, `ChatHeaderScreen` + `PresenceSubtitle`, `ChatComposer` (sections limitées côté E2EE), `ChatReplyBar` + `QuoteBlock`, `SwipeableBubble`, `ActionSheet`/`BottomSheet`, `Avatar`, `StickerView`/`StickerMessage`, `ImageViewer`/`VideoViewer`/`AlbumViewer`, `MediaMessage` (bulles image/vidéo/document, côté clair), `useChatColors` (palette WeChat partagée), `fr.ts` (textes E2EE), `message-receipt` (E2EE) vs `Ticks` (clair).

---

## 2. Tableau de correspondance des fonctionnalités

Légende état : E2EE = présent dans l'écran E2EE, Classique = présent dans l'écran classique, Les deux = présent des deux côtés. « Garde » = manière de le conserver dans l'écran unifié. « Protocole » = exigerait une évolution E2EE (autorisation requise, §5).

| # | Fonctionnalité | État actuel | Garde dans l'écran unifié |
|---|---|---|---|
| 1 | Texte | Les deux (outbox clair / enveloppe Olm `v:1`) | Deux pipelines d'envoi derrière une même UI ; le choix = `e2eeSince`, jamais le contraire |
| 2 | Réponses / citations | Les deux (`replyToId` outbox / `replyTo` chiffré dans `v:1`, aperçu reconstruit localement) | Conservé tel quel ; la citation cite un message du même pipeline |
| 3 | Réactions | Classique uniquement (`message:react`, chips, 6 stickers) | **Protocole** : nouveau `kind` payload chiffré + agrégation côté pair ; en attendant, section désactivée en mode E2EE (état actuel honnête) |
| 4 | Stickers Mbolo (catalogue + personnels) | Classique : envoi+réception ; E2EE : réception `v:3` seule, envoi désactivé (`:1386-1393`), `buildStickerV3` sans appelant production | Envoi E2EE = nouveau payload `v:3` émis (`sendEncryptedSticker` à créer) — **protocole** (format déjà défini, émission à brancher) |
| 5 | GIF | Classique : réutilisation d'URL autorisées (sans upload) ; E2EE : absent | Blob chiffré `v:2` possible dès maintenant (média) ; référence externe chiffrée = **protocole** |
| 6 | Photos/vidéos/documents | Les deux (upload clair signé / ciphertext chiffré STREAM + vignette chiffrée) | Deux chemins médias derrière la même UI ; jamais d'upload clair d'un média E2EE |
| 7 | Fichiers audio / notes vocales | Les deux (outbox `kind:'audio'` / `v:2` audio, waveform hors chiffrement) | Conservé ; lecture E2EE via `SecureVoicePlayer` |
| 8 | Progression d'envoi | Classique : `ProgressRing` ; E2EE : `sendingMedia` sans barre (`media.ts:349` sans callback) | Brancher le callback `onProgress` existant côté E2EE (aucun protocole) |
| 9 | Accusés Reçu/Ouvert | Classique : coches + Vu par ; E2EE : `Reçu` (présence) / `Ouvert` (visibilité réelle 50 %/400 ms) | Mode E2EE = règles actuelles ; mode historique = coches serveur ; jamais de lecture déclarée sans visibilité dans les deux modes |
| 10 | Présence réelle | Classique : `presenceStore` ; E2EE : `peerOnline` pilote « Reçu » | Conservé ; groupes = présence du classique (E2EE ne supporte pas les groupes, §5) |
| 11 | Typing « en train d'écrire » | Classique : événement avec texte ; E2EE : absent | **Protocole** si chiffré (enveloppe) ; en attendant, absent en mode E2EE |
| 12 | Profil du correspondant | Les deux (`/user/[id]`, `peerProfileRoute` par `peerId`) | Conservé ; jamais de clé par nom affiché |
| 13 | Avatars des deux côtés | Les deux (`Avatar`, `PresenceDot`) | Conservé |
| 14 | Menu contextuel au maintien | Les deux (`ActionSheet`, 320 ms) | Conservé ; actions filtrées selon le mode (transfert E2EE = texte seul, jamais vers le clair) |
| 15 | Réactions au-dessus / actions sous le message | Classique : chips sous la bulle + Vu par ; E2EE : `MessageReceiptLabel` sous la bulle | Conservé par mode ; les chips migrent avec les réactions (§3) |
| 16 | Supprimer pour moi | Les deux (cache local / SQLCipher + `message:delete forEveryone:false`) | Conservé |
| 17 | Supprimer pour tous | Classique : auteur, 24 h, événement `message:deleted` ; E2EE : explicitement non proposé (`:909-914`) | Mode historique = comportement serveur actuel ; mode E2EE = refus honnête (limite structurelle : la copie du pair est déchiffrée chez lui) |
| 18 | Transfert | Classique : absent ; E2EE : texte seul, ré-émission chiffrée vers une cible E2EE (`:949-992`) | Ajout classique = recréation via outbox (P1, migration non requise) ; cible E2EE = jamais de clair |
| 19 | Épinglage (conversation) | Hors écran (préférences via `/conversation-settings`) ; épinglage de message absent des deux | Hors périmètre fusion ; épinglage de message = P2 (migration + événement) |
| 20 | Brouillons | Classique : cache local (jamais écrit pour une conv. E2EE, `:645-649`) ; E2EE : SQLCipher chiffré | Conservé par mode ; en mode historique, brouillon local non chiffré assumé (données en clair) |
| 21 | Pagination / historique | Classique : `limit 30` + `before/after` ; E2EE : 200 locaux + 50 serveur, sans suite | Classique conservé ; E2EE = pagination locale SQLCipher à brancher (`searchLocalMessages` existe, `db.ts:501-514`) — aucune évolution protocole pour lire l'historique local |
| 22 | Groupes, rôles, permissions, mentions | Classique uniquement (les groupes ne sont jamais E2EE : `e2ee.service.ts` DIRECT seul) | Mode historique = comportement actuel complet ; mode E2EE = 1:1 (aucune régression : un groupe ne peut pas devenir E2EE) |
| 23 | Appels (audio/vidéo) | Classique : boutons actifs ; E2EE : icônes inertes + alerte (`:898-901,1285-1318`) | Mode historique = inchangé ; mode E2EE = refus explicite (appels chiffrés = **protocole**) |
| 24 | Recherche dans la conversation | Classique : absente de l'écran (route dédiée) ; E2EE : `searchLocalMessages` non branché | Recherche = chantier séparé (FTS5 SQLCipher côté E2EE, index clair côté historique) ; jamais d'indexation de clair E2EE côté serveur |
| 25 | Thèmes clair/sombre | Les deux (`useTheme`, `useChatColors`, `useTextScale`) | Conservé (palette déjà partagée) |
| 26 | Accessibilité TalkBack | Les deux (labels, `hitSlop`, `keyboardShouldPersistTaps`) ; ligne de discussion corrigée mission 1 | Conservé ; compléter les écrans restants (chantier indépendant) |
| 27 | Erreurs / chargement | Les deux (états `ready`/`fatal`, erreurs classifiées E2EE, bandeau hors ligne clair) | Conservé ; l'écran unifié doit afficher explicitement l'état de sécurité (chiffrée / historique en clair / bloquée) |

---

## 3. Architecture cible : un seul écran

### 3.1 Principe

Un seul fichier d'écran (`mobile/src/app/chat/[id].tsx` conservé comme route unique de compatibilité, voir §3.3) qui détermine son état de sécurité à l'ouverture à partir de **la réponse serveur** (`GET /conversations/:id` → `e2eeSince`, `type`, `members`) :

- `mode = 'e2ee'` si `isE2eeEnabled() && e2eeSince && type === 'DIRECT' && un pair unique identifiable` (même règle que `chatRouteFor`, `routing.ts:58-83`).
- `mode = 'classic'` sinon (conversation historique, groupe, ou drapeau E2EE coupé).
- `mode = 'blocked'` si `e2eeSince` est posé mais le pair est introuvable (même règle que `routing.ts:67-68`) : écran d'avertissement explicite, **aucun envoi**, jamais de repli clair.

L'état est affiché à l'utilisateur (en-tête : cadenas + mention « Conversation chiffrée » en mode E2EE ; mention « Historique en clair » en mode historique, sans prétendre au chiffrement).

### 3.2 Séparation des pipelines derrière l'UI commune

- **Abstraction de source de données** : deux adaptateurs derrière une même liste (`rows`) — adaptateur historique (outbox, `GET messages`, `receipts`, pagination 30) et adaptateur E2EE (SQLCipher, `listLocalMessages`, déchiffrement `v1`, visibilité `Ouvert`). Les composants d'affichage (bulles, compositeur, menus, citations) sont déjà partagés et restent communs.
- **Règle d'envoi** : en mode E2EE, seul l'envoi chiffré existe (`sendEncryptedText`, `sendEncryptedMedia`) ; en mode historique, seul l'envoi outbox existe. Aucun basculement de mode pendant la session (l'état est figé à l'ouverture ; un changement `e2eeSince` serveur = réouverture de l'écran).
- **Anti-downgrade** (déjà en place, inchangé) : le serveur refuse tout message en clair dans une conversation `e2eeSince` (`conversations.service.ts:1905-1907`) ; le client ne propose jamais d'envoi clair en mode E2EE et refuse l'envoi chiffré en mode historique.

### 3.3 Routage et compatibilité

- Toutes les entrées actuelles (`chats.tsx:547` via `chatRouteFor`, push `_layout.tsx:90,106` → `/chat/[id]`, `user/[id].tsx`, `new-message.tsx`, `conversation-search`, `invite`) ouvrent déjà la route unique par la garde `chat/[id].tsx:2586-2612`. **Aucun changement d'entrée n'est nécessaire** : l'écran unifié absorbe la garde au lieu de rediriger.
- `/e2ee-chat/[id]` est conservé comme **alias de transition** qui redirige vers `/chat/[id]` (sens inverse de l'actuelle redirection) tant que la compatibilité n'est pas démontrée ; suppression uniquement après autorisation explicite (Phase 5). Aucune boucle possible : un seul sens de redirection (alias → unique), l'écran unifié ne redirige jamais.
- Deep links préservés : `mbolochat://chat/<conversationId>` (notifications natives), `mbolochat://call/<callId>`, `/invite/<token>`. Le lien push ne porte que `conversationId/messageId` (`push.ts:201-205`) : `peerId` est inconnu à ce stade, la détermination du mode se fait donc **dans** l'écran unifié à partir de `GET /conversations/:id`, jamais dans la notification.
- Risque connu à traiter en Phase 5 : l'ouverture directe de `/e2ee-chat/[id]` pour une conversation historique affiche aujourd'hui un écran vide (historique filtré `v1`) sans retour automatique ; l'alias de transition doit aussi couvrir ce cas (détection `e2eeSince` absent → mode historique dans l'écran unifié, pas d'écran vide).

### 3.4 Fichiers concernés et risques de régression

| Fichier | Rôle dans la fusion | Risque |
|---|---|---|
| `mobile/src/app/chat/[id].tsx` (3 354 l.) | Route unique, absorption de la garde + adaptateur historique | Régression sur les groupes, l'outbox, les accusés — le risque le plus élevé, à intégrer par petites touches |
| `mobile/src/app/e2ee-chat/[id].tsx` (1 578 l.) | Base de l'UI unifiée (bulles chiffrées, menus, transfert, fiche) | Perte de règles E2EE (visibilité, `FLAG_SECURE`, brouillon SQLCipher) si mal fusionné |
| `mobile/src/features/e2ee/routing.ts` | Règle de mode réutilisée telle quelle (`chatRouteFor`, `directPeerOf`) | Faible : logique déjà testée (`routing.test.ts`) |
| `mobile/src/features/e2ee/{rows,receipts,read-visibility,text,media,db}.ts` | Pipelines E2EE inchangés | Aucun si non touchés (protocole intact) |
| `mobile/src/lib/{outbox,socket,api}.ts` | Envois clair + événements socket | Moyen : deux chemins d'envoi cohabitent, ne pas généraliser l'un en oubliant l'autre (règle AGENTS.md) |
| `mobile/src/features/chat/ui/*`, `composer/*`, `media/*` | Composants partagés | Faible : déjà communs |
| `mobile/src/app/_layout.tsx`, `push.ts`, `chats.tsx` | Entrées inchangées (la garde absorbe le choix) | Faible, sauf si on change les liens push (à ne pas faire) |

Stratégie de fusion (Phase 5, après autorisation) : **ne pas réécrire** — déplacer le contenu E2EE dans l'écran unique par sections vérifiables (garde/mode d'abord, puis adaptateur historique, puis adaptateur E2EE, puis menus), avec `tsc` + lint + tests après chaque section, et conservation des deux fichiers d'origine jusqu'à validation complète.

---

## 4. Fonctionnalités exigeant une évolution du protocole E2EE

Arrêt et autorisation explicite avant tout code (règle de la mission) :
- Réactions chiffrées (nouveau `kind` payload, agrégation côté pair, migration SQLCipher pour stocker les réactions).
- Typing chiffré (enveloppe éphémère).
- Édition de message chiffrée (nouveau type d'enveloppe + règle de remplacement locale).
- Envoi de stickers E2EE (brancher `buildStickerV3` existant — format déjà défini, mais c'est une émission nouvelle à valider avec tests crypto).
- GIF par référence externe chiffrée (sinon blob `v:2` possible sans protocole).
- Appels chiffrés (signalisation + clés DTLS/SRTP — WebRTC actuel non chiffré de bout en bout).
- Groupes E2EE (MLS/Sesame ou fan-out Olm, clés de groupe, migrations).
- Vérification d'identité hors bande, multi-appareil, sauvegarde chiffrée, sealed sender (déjà listés au plan directeur §7).

Sans protocole, la fusion conserve honnêtement l'état actuel : ces actions sont désactivées en mode E2EE avec un message explicite, exactement comme aujourd'hui.

---

## 5. Corrections réalisées et tests

Phase 1 : aucune correction (analyse uniquement, consigne de la mission).

Les Phases 2–4 et le reste de l'Étape 0 du plan directeur ont été menés ensuite. Le détail des correctifs, les fichiers touchés et les vérifications exécutées sont consignés en §9.

---

## 6. Vérifications Waydroid

Aucune dans cette phase (analyse statique du code). Waydroid : session en cours d'exécution au moment de la première mission, aucun appareil adb attaché, aucun APK construit (pas de build lourd local). Les vérifications visuelles des Phases 4–5 passeront par `npm run build:android` dans Waydroid ou un build EAS, avec mention explicite « vérifié sur Waydroid » ou « non vérifié faute de deuxième client » pour toute interaction E2EE entre appareils.

---

## 7. État Git

Avant la mission : HEAD `edee675`, 5 fichiers modifiés + 3 non suivis (correctifs CORS/accessibilité/plan directeur de la première mission, non committés). Après la Phase 1 : aucun code modifié ; seul ce document (`docs/UNIFICATION-CHAT-PLAN.md`, non suivi) est ajouté. Aucun commit, push, reset, checkout, restore ou suppression.

---

## 8. Éléments non vérifiés et raisons

- Comportement réel des deux écrans sur appareil (aucun APK construit, pas de deuxième client) : l'inventaire est statique, fondé sur le code lu.
- La limite du parseur JSON Express pour les uploads d'avatar (suspectée dans l'audit précédent) : à vérifier en direct en Phase 2 avant de fixer la limite base64.
- Dimensions d'images et risque de décompression : aucun décodeur d'image côté serveur aujourd'hui ; la décision (contrôle des dimensions ou non) relève de la Phase 2.
- L'appel non chiffré possible depuis `user/[id].tsx:114-128` vers un pair E2EE (aucun garde `e2eeSince` côté appels, relevé par l'étude de routage) : incohérence à traiter en Phase 5, signalée ici sans modification.

---

## 9. Suivi des Phases 2–4 et de l'Étape 0 (2026-11-09)

Cette section consigne le travail réalisé après la Phase 1. Les analyses des §1–4 restent valables ; aucun protocole E2EE, aucune clé, aucun payload et aucune migration n'ont été modifiés.

### 9.1 Phase 2 — validation binaire des images (A1–A3)

- `api/src/common/image-signature.ts` (+ `image-signature.spec.ts`) : détection JPEG/PNG/WebP par octets magiques, base64 strict (rejet des caractères hors alphabet et des longueurs incohérentes), extension déduite du contenu. SVG, HTML, GIF et conteneurs RIFF non-WebP refusés. Le serveur ne décode jamais l'image.
- `api/src/users/users.controller.ts` : avatar — plafond contrôlé **avant** décodage, base64 strict, signature binaire, écriture attendue (`finish`) avant publication de l'URL, suppression des anciennes extensions.
- `api/src/conversations/conversations.service.ts` : photo de groupe — mêmes règles (2 Mo décodés, signatures, extension issue du contenu).
- `api/src/main.ts` : parseurs JSON/urlencoded portés à 3 Mo (`bodyParser: false` + `json`/`urlencoded`), sinon le plafond de 2 Mo d'une image base64 était inatteignable (413 Express à 100 Ko avant tout contrôle applicatif).
- Tests : `image-signature.spec.ts` 5/5, `test/image-validation.e2e-spec.ts` 9/9 sur PostgreSQL réel (JPEG/PNG/WebP acceptés, extension déduite, SVG/HTML/base64 invalide/taille refusés, fichiers complets).

### 9.2 Phase 3 — DTO des corps bruts (B1–B2)

- Nouveaux DTO : `api/src/users/dto/update-me.dto.ts`, `api/src/users/dto/push-token.dto.ts`, `api/src/conversations/dto/add-members.dto.ts`, `api/src/auth/dto/refresh-token.dto.ts`.
- Bornes alignées sur les règles existantes : nom 48, bio 200, jeton push/refresh 512, `memberIds` ≤ 100 identifiants de 36 caractères ; les champs interdits de `PATCH /users/me` restent décorés pour conserver le rejet 400 explicite (ville, pays, anniversaire).
- Tests : `test/dto-validation.e2e-spec.ts` 7/7 ; comportements historiques conservés (tableau vide accepté, refresh sans jeton → 401, logout sans jeton → 204).

### 9.3 Phase 4 — performances des listes (C1–C3)

- `mobile/src/app/chats.tsx`, `chat/[id].tsx`, `e2ee-chat/[id].tsx` : `initialNumToRender`, `maxToRenderPerBatch`, `windowSize`, `updateCellsBatchingPeriod` ; `removeClippedSubviews` sur l'écran classique ; `keyExtractor`, `onScroll` et `onContentSizeChange` stabilisés hors du rendu.
- `ChatBubble` mémoïsé ; `Avatar` et `ImageMessageBubble` : `cachePolicy="disk"` + `recyclingKey` pour le cache disque `expo-image`.
- `api/test/perf-seed.e2e-spec.ts` (temporaire) : semis de 200 messages, désormais **ignoré par défaut** — il ne s'exécute que si `PERF_SEED_DEVICE_USER_ID` désigne le compte de test de l'appareil, afin de ne pas casser `npm run test:e2e` sur une base neuve.
- **Mesure sur appareil non réalisée** : `adb devices` vide, Waydroid en session `RUNNING` mais conteneur `STOPPED`, aucun APK présent, build local interdit par AGENTS.md. À reprendre via `npm run build:android` dans Waydroid ou un build EAS, puis `PERF_SEED_DEVICE_USER_ID=<uuid> npx vitest run --config ./vitest.config.e2e.ts test/perf-seed.e2e-spec.ts`.

### 9.4 Étape 0 restante — i18n des actions destructrices et accessibilité

- `mobile/src/i18n/fr.ts` : nouveau namespace `fr.chat` (menus, « Supprimer pour moi », « Retirer pour tous », alertes stickers, erreurs copie/suppression, sélecteurs photo/fichier, micro) ; `fr.common.openSettings` ; `fr.media.uploadProgress`.
- `mobile/src/app/chat/[id].tsx` : plus aucune action destructrice ni libellé de menu en dur ; « Réessayer », « Supprimer ce sticker/message/fichier » et « Réessayer l'envoi » centralisés ; régions live sur l'indicateur de saisie, le bandeau hors ligne et l'erreur.
- `login.tsx` / `register.tsx` : étiquettes sur les champs, bouton « Mot de passe oublié », genre en boutons radio, région live sur les erreurs.
- `components/select.tsx` : déclencheur accessible (bouton, état `expanded`) et options en radios (`checked`).
- `features/groups/InviteSheet.tsx` : chips avec état `selected`, switch avec libellé et aide, QR code étiqueté.
- `features/calls/CallScreen.tsx` / `ui/CallHeader.tsx` : surface d'appui plein écran étiquetée quand les commandes sont masquées ; statut d'appel en région live.
- `features/media/ProgressRing.tsx` : `accessibilityRole="progressbar"` et `accessibilityValue` 0–100 (ou indéterminé), libellé par défaut.
- `maxFontSizeMultiplier` posé sur les éléments compacts à hauteur fixe (horodatage et pastille de non-lus de la ligne de discussion, mention « Réessayer » de la pastille d'envoi) ; le texte courant reste librement scalable.

### 9.5 Vérifications exécutées

- API : `npx tsc --noEmit` OK ; `npx oxlint --type-aware src/ test/` 0 erreur (3 avertissements préexistants : `calls.service.ts:16`, `e2ee.e2e-spec.ts:3`, `group-calls.service.spec.ts:282`, hors sujet) ; `npm test` 112/112 ; e2e images 9/9 ; e2e DTO 7/7 ; perf-seed ignoré par défaut.
- Mobile : `npx tsc --noEmit` OK ; `expo lint` sur tous les fichiers touchés OK (l'erreur `chats.tsx:143` préexiste à HEAD, bruit connu listé par AGENTS.md) ; `npm test` 344/344.
- Aucun test visuel sur appareil (voir §9.3) ; aucune interaction E2EE entre deux clients.
- Aucun commit, push, reset, checkout, restore ou suppression.

### 9.6 Reste à faire

- Phase 5 (fusion des écrans) : **autorisation explicite requise** (§4 du présent document et §7 du plan directeur).
- Mesure de performance sur appareil, puis suppression de `perf-seed.e2e-spec.ts`.
- Chantiers P1 sans autorisation : transfert en clair, recherche globale FTS5 côté mobile, vitesse de lecture vocale. L'édition de message exige une migration (`edited_at`) et reste donc soumise à autorisation.

---

## 10. Audit de parité Phase 5 (Étape B.1, lecture seule)

Base : branche `refactor/phase-5-unification-chat`, HEAD `566bd9b`. Lecture intégrale de `mobile/src/app/chat/[id].tsx` (3 372 lignes) et `mobile/src/app/e2ee-chat/[id].tsx` (1 600 lignes), plus les modules importés (transport, E2EE, composants partagés, outbox, cache). Aucun code applicatif modifié dans cette étape.

### 10.1 Matrice de parité

Relation : **identique** = même code partagé ; **divergent** = même fonction, implémentations ou sémantiques différentes ; **propre** = présent d'un seul côté. Risque = risque de régression lors de la fusion.

| Fonctionnalité | `chat/[id].tsx` | `e2ee-chat/[id].tsx` | Relation | Risque |
|---|---|---|---|---|
| Envoi texte | Outbox SQLite `enqueue` + `drain`, `clientId` idempotent (l. 2475-2500) | `sendEncryptedText` par socket direct, enveloppe Olm, ligne SQLCipher provisoire (l. 714-764) | Divergent | **Élevé** : anti-downgrade, deux pipelines à ne pas confondre |
| Réception | `message:new` + `mergeMessages` + cache mémoire/disque + accusés (l. 197-224, 704-883) | Chaîne de déchiffrement sérialisée + SQLCipher, aucun accusé au chargement (l. 334-381, 569-592) | Divergent | **Élevé** : ordre des déchiffrements, doublons de ratchet |
| Pagination | `before` + `limit 30`, `hasMore` (l. 1283-1302) | 200 messages locaux + 50 serveur au premier chargement, **sans pagination** (l. 418-426) | Divergent | Moyen : l'écran chiffré est incomplet, pas de régression à introduire |
| Notes vocales | Outbox `kind:'audio'`, waveform en mémoire de session (l. 1930-1999, 2432-2453) | `sendEncryptedMedia` `v:2` audio, `SecureMediaMessage` (l. 886-896, 1122-1184) | Divergent | Moyen : waveform non chiffrée d'un côté, clair temporaire de l'autre |
| Images et vidéos | Upload clair + URL signée, album, GIF, documents (l. 2082-2238) | Ciphertext STREAM, miniature chiffrée, clair temporaire + `closeMedia` (l. 1122-1184, 898-904) | Divergent | **Élevé** : toute fuite de clair ou oubli de `closeMedia` est une régression de sécurité |
| Réponses / citations | `replyToId` outbox + `quoteOfMessage` depuis le message (l. 1393-1397, 2243-2248) | `replyToId` chiffré + `resolveQuote` depuis SQLCipher (l. 295-317, 1278-1291) | Divergent | Faible : même rendu via `QuoteBlock` |
| Réactions | Chips + `message:react` optimiste, stickers fermés (l. 410-466, 1364-1391) | Absent | Propre au clair | Faible : à masquer honnêtement en mode chiffré |
| Suppression | Pour moi + pour tous (auteur, 24 h) (l. 1410-1435, 1529-1549) | Pour moi seulement, refus honnête pour tous (l. 942-960, 1054-1060) | Divergent | Moyen : ne jamais promettre « pour tous » en E2EE |
| Accusés de lecture | Coches serveur, « Vu par N » en groupe (l. 256-334, 769-785, 1744-1754) | « Reçu » (présence) / « Ouvert » (visibilité réelle 50 %, 400 ms) (l. 62-70, 474-523, 1114) | Divergent (sémantique) | **Élevé** : deux définitions de la lecture à préserver par mode |
| Indicateur de frappe | Événement `typing` avec texte, texte coupé si drapeau E2EE (l. 603-645, 755-768) | Absent | Propre au clair | Faible |
| Brouillon | Cache AsyncStorage non chiffré, purgé si conversation E2EE (l. 518-521, 615-654) | SQLCipher + file d'écriture sérialisée (l. 220-234, 403-417, 766-769) | Divergent | **Élevé** : un brouillon clair dans une conversation chiffrée est interdit |
| Défilement | Liste inversée, pastille de retour, compteur d'invisibles (l. 1261-1350, 2677-2693) | Liste non inversée, `scrollToEnd` sur changement de taille (l. 269-293, 1353-1391) | Divergent | Moyen : jank sur Android modeste |
| État de connexion | Bandeau hors ligne + reconnexion socket (l. 928, 2756-2763) | Pas de bandeau ; portes `focus`/`appActive`/`ready` pour accusés (l. 192-206, 541-567) | Divergent | Faible/Moyen : informer sans casser les portes |
| Menus | Réponse, copier, supprimer/pour tous, favori sticker + sélecteur de réactions (l. 1437-1561, 2870-2907) | Réponse, transférer, copier, infos, supprimer pour moi (l. 1020-1062, 1437-1442) | Divergent | Moyen : actions filtrées par capacités |
| Accessibilité | Étiquettes coches/actions, régions live erreur/hors ligne/frappe (l. 309-334, 2756-2772) | Étiquettes + titre « voir le profil » + appels désactivés annoncés (l. 1310-1342) | Divergent (libellés) | Moyen : ne perdre aucune étiquette en fusionnant |
| Groupes, rôles, permissions, mentions | Complet : rôles, `whoCanSend`, mentions `@`, « Vu par » (l. 2810-2865) | 1:1 forcé, membres synthétiques (l. 663-707) | Propre au clair | **Élevé** : un groupe ne peut pas devenir E2EE, ne pas généraliser |
| Appels | Actifs 1:1 et groupe (l. 1182-1259) | Icônes inertes + alerte explicite (l. 1316-1342, 924-927) | Divergent | Moyen : aucun appel non chiffré depuis l'écran chiffré |
| Sécurité d'écran | Aucun `FLAG_SECURE` | `useSecureScreen(true)`, balayage des médias, fermeture base (l. 160, 594-607) | Propre au chiffré | **Élevé** : ne jamais perdre `FLAG_SECURE` ni le sweep |

### 10.2 Code dupliqué (estimation)

Les composants de présentation sont déjà partagés (`ChatBubble`, `ChatComposer`, `ChatHeaderScreen`, `ChatReplyBar`, `ChatDateSeparator`/`ChatTimeSeparator`, `QuoteBlock`, `SwipeableBubble`, `ActionSheet`, visionneuses, sélecteurs média). La duplication restante est surtout **logique et structurelle** :

| Zone | Clignotement clair | Équivalent chiffré | Duplication estimée |
|---|---|---|---|
| Construction des rangées (dates, heures, continuations, albums, non-lus) | `rows` inline, l. 930-1018 (~89 l.) | `buildMessageRows` dans `features/e2ee/rows.ts` (~60 l.) | ~60 l. de logique parallèle (l'album et le non-lu manquent côté chiffré) |
| Chargement, socket, abonnements, accusés | l. 656-928 (~270 l.) | l. 383-592 (~210 l.) | ~200 l. de structure parallèle |
| Envoi et sélection de médias | l. 2318-2599 (~280 l.) | l. 709-899 (~190 l.) | ~180 l. de flux parallèles (outbox vs chiffrement direct) |
| Menus et actions de message | l. 1437-1561 (~125 l.) | l. 1020-1062 (~43 l.) | ~45 l. |
| Styles quasi identiques | 15 clés (`mediaBlock`, `emojiOnly*`, `sticker*`, `messageText`, `listContent`…) | mêmes 15 clés recopiées | ~50 l. |
| **Total** | | | **~500-600 l.** de logique/styles dupliqués, hors divergence structurelle des écrans (3 372 vs 1 600 l.) |

### 10.3 Points d'accès cryptographiques — zone interdite

Ces modules sont **appelés** par la future interface de transport, jamais modifiés dans la Phase 5 :

- `features/e2ee/text.ts` : `encryptEnvelope` (l. 120), `sendEncryptedText` (l. 321), `decryptIncoming` (l. 660), `decryptEnvelope` (l. 589) — ratchet Olm, sessions, enveloppes.
- `features/e2ee/media.ts` : `sendEncryptedMedia` (l. 250), `resumeEncryptedMedia` (l. 525), plafonds et dimensions (l. 54-67) — chiffrement STREAM des médias.
- `features/e2ee/payload.ts` : construction/lecture des payloads `v:1` texte, `v:2` média, `v:3` sticker.
- `features/e2ee/db.ts` : schéma SQLCipher, `saveLocalMessage`, `listLocalMessages`, `saveDraft`/`loadDraft`.
- `features/e2ee/initRunner.ts` / `initState.ts` : Keystore, publication des clés, reprise.
- `features/e2ee/mediaStore.ts` / `SecureMediaMessage.tsx` : clair temporaire, `sweepSecureMedia`, `closeMedia`.
- `features/e2ee/draftQueue.ts` : ordre des écritures chiffrées.
- `features/e2ee/screen-security.ts` : `FLAG_SECURE`.
- `features/e2ee/receipts.ts` / `read-visibility.ts` : règles `Reçu`/`Ouvert` (confidentialité, quasi cryptographiques).
- `features/e2ee/policy.ts` / `routing.ts` : mode et routage.
- Côté serveur : `api/src/e2ee/*`, `api/src/db/schema.ts`, `api/drizzle/*` — aucune migration, aucun protocole.

### 10.4 Points chauds de performance

1. **État de saisie dans l'écran** : `onInputChange` (clair, l. 615-645) et `onChangeDraft` (chiffré, l. 766-769) font un `setState` par frappe dans l'écran parent → re-rendu de la `FlatList` et de toutes les lignes visibles. C'est le point chaud principal, à isoler dans le futur `ChatInputBar`.
2. **`renderItem` clair** : une fonction de 721 lignes (l. 1595-2316) avec 18 dépendances, recréée à chaque changement de `receipts`, `queuedById`, `typing` ou `voiceWaveforms` → toutes les bulles se re-rendent. À découper par type de rangée et mémoïser.
3. **`renderRow` chiffré** : fonction ordinaire recréée à chaque rendu (l. 1064), avec un objet `rowProps` inline par ligne (l. 1082-1090) → aucune mémoïsation possible.
4. **`resolveQuote` chiffré** : `messages.find` par ligne (l. 296-317) → O(n²) sur l'historique.
5. **Insertion chiffrée** : `sortMessages` retrie et déduplique tout le tableau à chaque message reçu (l. 115-124, 326-332) → O(n log n) par message.
6. **Liste chiffrée non inversée** : `onContentSizeChange` → `scrollToEnd` (l. 291-293) provoque des mesures/ajustements répétés pendant le chargement.
7. **Composants de ligne non mémoïsés** : `Ticks`, `MessageReceiptLabel`, `ChatMessageRow` n'ont pas de `memo` ; à ajouter avec des props stables.
8. **Objets inline** : `style={{ opacity: waiting ? 0.55 : 1 }}` (clair l. 1787), `rowProps` (chiffré l. 1082), `conversation` synthétique recréée à chaque rendu (l. 663-707).
9. **Cartographie des coches** : `tickById` reparcourt tous les messages à chaque accusé (l. 1122-1139) ; acceptable mais à garder hors du rendu de liste.
10. **Brouillon clair** : `cache.setDraft` est déjà regroupé par `scheduleWrite` (pas d'écriture disque par frappe) ; le coût restant est le `setState` de l'écran (point 1).

### 10.5 Code mort

- `chat/[id].tsx` : **28 clés de styles jamais référencées** (~90-110 lignes), reliquats de l'extraction vers les composants partagés : `headerBackground`, `headerTitleBody`, `headerTitleText`, `headerName`, `headerSubtitle`, `headerAction`, `center`, `emptyText`, `emptyChat`, `reactionChipEmoji`, `reactionPickerEmoji`, `emptyTitle`, `suggestions`, `suggestion`, `bubble`, `bubbleMineEdge`, `bubbleTheirsEdge`, `tail`, `tailLeft`, `tailRight`, `replyBar`, `replyBarBody`, `replyClose`, `dateRow`, `datePill`, `dateText`, `timeRow`, `timeText`.
- `e2ee-chat/[id].tsx` : aucune clé de style morte.
- Aucun `console.log`, `TODO`, `FIXME` ou `XXX` dans les deux écrans.
- Aucune fonction utilitaire manifestement inutilisée (les helpers privés sont tous appelés).

### 10.6 Architecture cible

Principe : l'écran ne connaît que **une interface de transport** et des **composants de présentation**. Le mode (`classic` / `e2ee`) est décidé à l'ouverture à partir de `GET /conversations/:id` + `chatRouteFor`, puis figé pour la session. Aucune bascule de pipeline en cours d'écran.

#### 10.6.1 Interface de transport

```ts
// features/chat/transport/types.ts
export type ChatMode = 'classic' | 'e2ee' | 'blocked';

export interface ChatCapabilities {
  replies: boolean;
  reactions: boolean;
  deleteForEveryone: boolean;
  stickers: boolean;
  gifs: boolean;
  voice: boolean;
  typing: boolean;
  calls: boolean;
  albums: boolean;
  groups: boolean;
  encrypted: boolean;
  pagination: 'server' | 'local';
  receipts: 'ticks' | 'delivered-opened';
}

export interface ChatMessageView {
  id: string;
  clientId: string | null;
  conversationId: string;
  mine: boolean;
  sender: { id: string; displayName: string; username: string; avatarUrl: string | null; gender: Gender | null };
  createdAt: string;
  body: string;
  deleted: boolean;
  unreadable: boolean;
  quoteId: string | null;
  reactions: ReactionSummary[];
  stickerRef: string | null;
  attachment: ChatAttachmentView | null; // type, url ou référence chiffrée, dimensions, nom, taille, durée
  type: Message['type'];
  state: 'none' | 'pending' | 'failed' | 'sent' | 'delivered' | 'read';
  error: string | null;
  progress: number | null;
}

export interface ChatSnapshot {
  messages: ChatMessageView[];
  receipts: Record<string, MessageReceipt[]>;
  hasMore: boolean;
  unreadCount: number;
}

export interface ChatTransportHandlers {
  onMessage(message: ChatMessageView): void;
  onMessageRemoved(id: string, forEveryone: boolean): void;
  onReceipts(receipts: MessageReceipt[]): void;
  onTyping(state: { userId: string; text: string } | null): void;
  onConnection(online: boolean): void;
  onConversationUpdated(summary: ConversationSummary): void;
  onConversationRemoved(): void;
  onError(error: string | null): void;
  onFatal(failure: E2eeInitFailure | null): void;
}

export interface ChatTransport {
  readonly mode: 'classic' | 'e2ee';
  readonly conversationId: string;
  readonly capabilities: ChatCapabilities;

  loadInitial(): Promise<ChatSnapshot>;
  loadOlder(beforeCreatedAt: string): Promise<{ messages: ChatMessageView[]; hasMore: boolean }>;
  subscribe(handlers: ChatTransportHandlers): () => void;
  dispose(): Promise<void>;

  sendText(text: string, replyToId: string | null): Promise<void>;
  sendMedia(asset: OutgoingAsset, caption: string, replyToId: string | null): Promise<void>;
  sendSticker(ref: string): Promise<void>;
  sendGif(gif: RecentGif): Promise<void>;
  sendVoice(note: VoiceNote): Promise<void>;

  deleteMessage(id: string, forEveryone: boolean): Promise<void>;
  toggleReaction(id: string, reaction: string): Promise<void>;
  markRead(ids?: string[]): Promise<void>;
  reportDelivered(ids: string[]): void;
  setTyping(active: boolean, text?: string): void;
  saveDraft(text: string): void;
  retry(id: string): void;
  discard(id: string): Promise<void>;
}
```

**Une seule source de vérité : `capabilities`.** Toutes les méthodes existent quelle que soit l'implémentation ; une méthode non supportée vérifie son drapeau et lève un **refus typé** (`UnsupportedCapabilityError`, champ `capability`), jamais un `throw` générique ni une méthode absente. L'interface ne teste que `capabilities`, jamais `mode`, pour décider ce qu'elle affiche ou appelle.

Deux implémentations : `classic-transport.ts` (cache + `api` + `outbox` + `socket` + `sync`) et `e2ee-transport.ts` (SQLCipher + `sendEncryptedText`/`sendEncryptedMedia` + `decryptIncoming` + `receipts` + `read-visibility` + `draftQueue`).

#### 10.6.2 Hooks

- `useChatConversation(id)` : résumé serveur, mode (`chatRouteFor`), état `blocked`/`fatal`.
- `useChatTransport(mode, summary)` : instancie l'implémentation, la dispose au démontage.
- `useChatMessages(transport)` : snapshot, abonnements, pagination, `rows` (modèle unifié), `ready`.
- `useChatReceipts(transport, mode)` : coches ou `Reçu`/`Ouvert`.
- `useChatDraft(transport)` : **état de saisie isolé** dans le composant de barre ; écritures débouncées, `typing` throttlé, aucune remontée dans l'écran.
- `useChatScroll(rows)` : **liste inversée dans les deux modes**, pastille de retour, compteur d'invisibles, `scrollToMessage`.
- `useChatActions(transport, capabilities)` : `SheetAction[]` filtrées par mode.
- `useChatMediaViewer()` : image/album/vidéo/document, `closeMedia` côté chiffré.

#### 10.6.3 Composants

- `ChatScreen` : coquille de mise en page, aucun accès direct aux données.
- `ChatMessageList` : `FlatList` réglée une fois (`initialNumToRender`, `maxToRenderPerBatch`, `windowSize`, `updateCellsBatchingPeriod`, `removeClippedSubviews`), `renderItem` memoïsé par type.
- `ChatMessageRow` (mémoïsé) : présentation d'une `ChatMessageView` (texte, emoji, sticker, média, vocal, album, système/appel, supprimé, illisible) + coche/libellé d'accusé.
- `ChatInputBar` : compositeur + barre de réponse + panneau pièces jointes + bandeau bloqué ; **propriétaire du texte**.
- `ChatHeaderBar` : titre, présence, actions d'appel actives ou inertes, mention de sécurité.
- `ChatSheets` : menu message, « Vu par », informations, transfert.
- `ChatSecurityBanner` : « Conversation chiffrée » / « Historique en clair » / « Bloquée ».
- Réutilisés tels quels : `ChatBubble`, `chat-rows`, `chat-header`, `chat-reply-bar`, `chat-empty-state`, `message-receipt`, `QuoteBlock`, `SwipeableBubble`, `ActionSheet`, visionneuses, `ChatComposer`.

#### 10.6.4 Arborescence et stratégie additive

**Tout le nouveau code vit dans des fichiers neufs sous `features/chat/`.** Les écrans `chat/[id].tsx` et `e2ee-chat/[id].tsx` restent inchangés jusqu'à B.3.5 ; aucun style mort n'est nettoyé (il disparaît avec les fichiers en B.3.6). Aucun export n'est ajouté dans `features/e2ee/` : les modules existants sont importés tels quels. Si un accès manque, le travail s'arrête et l'ingénieur est consulté.

```
mobile/src/features/chat/
  transport/
    types.ts             (ChatTransport, capacités, vues, handlers, refus typé)
    deps.ts              (interfaces de dépendances injectables)
    classic-transport.ts
    e2ee-transport.ts
    contract.ts          (suite de contrat partagée — tests uniquement)
    use-chat-transport.ts
  model/
    message-view.ts      (Message | StoredE2eeMessage → ChatMessageView)
    merge.ts             (fusion triée, déduplication, frontière de non-lus, coches)
    message-index.ts     (Map par id + insertion triée incrémentale)
    rows.ts              (rangées unifiées : dates, heures, continuations, albums, non-lus)
  mode/
    resolve-chat-mode.ts (mode + anti-downgrade + attente hors ligne)
  hooks/
    use-chat-conversation.ts
    use-chat-messages.ts
    use-chat-draft.ts
    use-chat-scroll.ts
    use-chat-actions.ts
    use-chat-media.ts
  ui/
    chat-screen.tsx
    chat-message-list.tsx
    chat-message-row.tsx
    chat-input-bar.tsx
    chat-header-bar.tsx
    chat-sheets.tsx
    chat-bubble.tsx / chat-rows.tsx / chat-header.tsx / chat-reply-bar.tsx / chat-empty-state.tsx (existants)
mobile/src/app/chat/[id].tsx        → inchangé jusqu'à B.3.5 (puis 3 lignes : drapeau)
mobile/src/app/e2ee-chat/[id].tsx   → inchangé jusqu'à B.3.5 (alias de transition)
```

#### 10.6.5 Résolution du mode et comportement hors ligne

```ts
// features/chat/mode/resolve-chat-mode.ts
export type ChatModeResolution =
  | { kind: 'classic'; summary: ConversationSummary }
  | { kind: 'e2ee'; summary: ConversationSummary; peer: DirectPeer }
  | { kind: 'blocked'; reason: 'peer_missing' | 'group_mismatch' }
  | { kind: 'pending'; reason: 'summary_unknown' };
```

Règles, dans l'ordre :

1. **Serveur prioritaire** : `GET /conversations/:id` s'il est disponible.
2. **Repli cache local** : `cache.getConversation(id)` (résumé signé reçu précédemment).
3. **Jamais de `classic` par défaut** : un résumé absent, partiel ou dont le champ `e2eeSince` est `undefined` (ancien cache) est **inconnu**, pas « en clair ».
4. Résumé inconnu + réseau indisponible → `pending` : écran d'attente explicite, **sans compositeur**, nouvelle tentative au retour du réseau. Aucun envoi n'est possible tant que le mode n'est pas établi.
5. `e2eeSince` posé + drapeau E2EE actif → `e2ee` si `DIRECT` avec un pair unique identifiable ; sinon `blocked` (`peer_missing`, `group_mismatch`). Un groupe avec `e2eeSince` est une incohérence : refus, jamais de repli clair.
6. `e2eeSince` posé + drapeau E2EE désactivé → `classic` : c'est une **configuration explicite**, pas un doute. Le serveur reste l'autorité anti-downgrade et refusera tout envoi clair.
7. Résumé complet avec `e2eeSince: null` → `classic`.
8. Le mode est **figé** à l'ouverture ; un changement serveur impose de rouvrir l'écran.

Tests prévus : serveur e2ee, cache e2ee hors ligne, cache absent hors ligne → `pending` (pas `classic`), cache sans champ `e2eeSince` → `pending`, cache complet `null` → `classic`, e2ee sans pair → `blocked`, groupe + `e2eeSince` → `blocked`, drapeau désactivé → `classic`.

#### 10.6.6 Transports testables et suite de contrat

Les dépendances sont **injectées** (aucun singleton importé directement dans la logique) :

```ts
export interface ClassicTransportDeps {
  api: { getConversation; listMessages; listReceipts };
  cache: { getConversation; getMessages; setMessages; setConversation; getDraft; setDraft; clearDraft };
  outbox: { enqueue; drain; listOutbox; subscribe; onSent; discard; retry; pendingMessage; localCreatedAtMs };
  socket: { connectSocket; getSocket; onConnection; reportDelivered; deleteMessage; toggleReaction };
  sync: { advanceCursor; onMissedMessages };
  clock: () => number;
  newClientId?: () => string;
}

export interface E2eeTransportDeps {
  api: { listMessages; listReceipts; markMessagesRead };
  socket: { connectSocket; ensureSocket; reportDelivered; deleteMessage };
  db: { openE2eeDatabase; loadE2eeAccount; listLocalMessages; knownMessageKeys; saveDraft; loadDraft; deleteLocalMessage };
  crypto: { sendEncryptedText; sendEncryptedMedia; decryptIncoming }; // imports existants, aucune modification
  receipts: { mergeReceipts; receiptState; deliveredIds; canMarkRead; canReportDelivered };
  readVisibility: { visibleForeignMessageIds };
  clock: () => number;
}
```

`contract.ts` expose une suite unique exécutée contre les deux transports avec des faux : ordre chronologique, déduplication (id + `clientId`), idempotence d'un même `clientId`, suppression pour moi / pour tous, cohérence des `capabilities` avec les méthodes autorisées. Tests de sécurité séparés :

- le transport chiffré n'appelle **jamais** l'outbox ni un upload en clair (faux qui échouent si appelés) ;
- le transport classique **refuse** une conversation `e2eeSince` (construction/ouverture en erreur typée), même si l'appelant se trompe de mode.

#### 10.6.7 Défilement inversé (les deux modes)

`useChatScroll` impose une liste inversée dans les deux modes. Côté chiffré, c'est un **changement de comportement du seul défilement** (aujourd'hui non inversé + `scrollToEnd`) : à vérifier sur appareil. La logique de visibilité qui déclenche « Ouvert » (`READ_VIEWABILITY_CONFIG`, 50 %/400 ms, `visibleForeignMessageIds`) reste **intacte** : l'inversion change l'indexation visuelle, pas la règle de lecture. Point de contrôle : un message qui traverse l'écran ne doit toujours pas être marqué lu.

#### 10.6.8 Performance : chaque point chaud et son pas de correction

| Point chaud §10.4 | Correction | Pas |
|---|---|---|
| 1. `setState` de saisie dans l'écran | état possédé par `ChatInputBar` + `useChatDraft`, aucun état de texte dans l'écran | B.3.2/B.3.3 (hooks), B.3.4 (barre) |
| 2. `renderItem` clair de 721 lignes, 18 dépendances | découpage par type de rangée + `memo` + props stables | B.3.4 |
| 3. `renderRow` chiffré recréé à chaque rendu | composant mémoïsé, `rowProps` construit hors rendu de liste | B.3.4 |
| 4. `resolveQuote` en O(n²) | **index `Map` par identifiant** dans `message-index.ts` ; plus aucun `find` par ligne | B.3.1 (index), B.3.3 (usage) |
| 5. `sortMessages` complet à chaque message | **insertion triée incrémentale** dans `MessageIndex`, avec test d'équivalence contre le tri complet | B.3.1 |
| 6. liste chiffrée non inversée + `scrollToEnd` | liste inversée unifiée | B.3.2 (hook), B.3.5 (bascule) |
| 7. lignes non mémoïsées (`Ticks`, `MessageReceiptLabel`, `ChatMessageRow`) | `memo` + props primitives/stables | B.3.4 |
| 8. objets/styles inline par ligne | styles statiques, objets mémoïsés | B.3.4 |
| 9. `tickById` recalculé à chaque accusé | transformation mémoïsée dans le hook de messages | B.3.2/B.3.3 |
| 10. brouillon écrit par frappe | `saveDraft` débouncé dans le transport, état local à la barre | B.3.2/B.3.3 |

`MessageIndex` conserve une `Map<id, ChatMessageView>` et un tableau trié ; `upsert` insère à la bonne position (recherche binaire) au lieu de retrier. Le test compare, sur des séquences aléatoires déterministes, le résultat de `upsert` répétés au résultat du tri complet puis déduplication.

#### 10.6.9 Ordre d'exécution révisé

| Pas | Contenu | État |
|---|---|---|
| B.2 | Tests de caractérisation des fonctions pures (copies exportées dans des fichiers neufs, écrans inchangés) + `docs/CHECKLIST-VALIDATION-APPAREIL.md` | à faire |
| B.3.1 | Types, modèle unifié, fusion, index, rangées, résolution de mode (fichiers neufs) | à faire |
| B.3.2 | Transport classique + hooks (fichiers neufs, **non branchés**) + début de la suite de contrat | à faire |
| B.3.3 | Transport chiffré + suite de contrat complète + tests de sécurité | à faire, puis **arrêt et rapport** |
| B.3.4 | Composants de présentation | après validation |
| B.3.5 | Écran unifié + **drapeau de configuration activé par défaut** : la route choisit le nouveau ou l'ancien écran. Retour arrière depuis `/dev-flags` ; diff limité à quelques lignes dans les anciens écrans | après validation |
| B.3.6 | Preuve de parité (checklist appareil) puis retrait des anciens écrans et des styles morts | après validation |

Aucun ancien écran n'est supprimé avant B.3.6 et la validation utilisateur. Chaque pas est un commit vert (`tsc`, lint, tests).

### 10.7 Risques, garde-fous et backlog

- **Stratégie additive** : les anciens écrans ne bougent pas avant B.3.5 ; aucun nettoyage de style mort avant la suppression des fichiers.
- **Bascule réversible** : en B.3.5, un drapeau de configuration activé par défaut sélectionne l'écran unifié ; `/dev-flags` permet encore de revenir à l'ancien comportement.
- **Anti-downgrade et hors ligne** : résumé inconnu ou incomplet → attente sans compositeur, jamais `classic` par défaut ; le cache local fournit `e2eeSince` quand le réseau manque.
- **Zone crypto** : `features/e2ee/` (text, media, payload, db, init, mediaStore, draftQueue, receipts, read-visibility, policy, routing) est importé, jamais modifié ni étendu d'un export. Blocage et demande si un accès manque.
- **Sécurité d'écran** : `FLAG_SECURE`, sweep des médias, brouillons SQLCipher et sémantique `Reçu`/`Ouvert` restent propres au mode chiffré.
- **Défilement** : l'inversion côté chiffré est un changement visible, à valider sur appareil ; la règle de visibilité « Ouvert » ne change pas.
- **Pagination chiffrée** : incomplète aujourd'hui ; la fusion conserve l'existant, sans promesse nouvelle.
- **Performance** : sans isolation de la saisie et sans index, la fusion aggraverait le re-rendu de liste.
- **Tests** : le socle Vitest ne monte pas de composants RN ; la couverture porte sur les fonctions pures, les transports (contrat, sécurité) et la résolution de mode.
- **Backlog sécurité (priorité haute, hors Phase 5)** : `mobile/src/app/user/[id].tsx:114-128` permet de lancer un appel non chiffré vers un pair dont la conversation est `e2eeSince`. Aucun garde `e2eeSince` côté appels. **Non corrigé dans cette phase** ; à traiter avant toute exposition publique des appels E2EE.

### 10.8 Prochain pas

B.2 (caractérisation + checklist appareil), puis B.3.1, B.3.2 et B.3.3, avec un commit vert par pas. Arrêt et rapport court après B.3.3, sans commencer B.3.4.
