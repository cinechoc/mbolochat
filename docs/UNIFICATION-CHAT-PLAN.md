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
