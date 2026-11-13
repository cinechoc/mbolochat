MBOLOCHAT — PLAN DIRECTEUR D'AMÉLIORATION

Version 1.0 — 2026-11-09
Base : commit `edee675` (master, arbre propre en début de mission ; aucune modification committée pendant la mission).
Méthode : audit lecture seule du code (backend, mobile, E2EE/sécurité) + étude comparative à partir de la documentation publique officielle de WhatsApp, WeChat, Telegram, Messenger, Signal, Instagram et Snapchat, et des guides React Native/Expo. Aucune protection contournée, aucune fonctionnalité inventée : [Doc] = comportement documenté dans l'app de référence, [Reco] = recommandation pour MboloChat.

Règles de la mission appliquées : aucun commit, aucun push, aucune réinitialisation Git, aucune suppression de fichier, aucune modification de données de production, aucun changement de protocole E2EE, de clés, de payload ou de migration cryptographique. Les améliorations menées pendant la mission sont listées en §9 (non commitées, réversibles).

---

## 1. Fonctionnalités déjà disponibles

### 1.1 Messagerie classique (API + mobile)
- Envoi temps réel Socket.IO avec `clientId` idempotent (`UNIQUE(sender_id, client_id)`), passage par l'outbox SQLite mobile avec reprise hors ligne (`mobile/src/lib/outbox.ts`).
- Texte ≤ 4000 caractères, stickers du catalogue MboloChat (panthère), GIF, réponses avec citation (`reply_to_id`, même conversation), réactions (liste fermée de 6 stickers, événement `message:reaction`), suppression pour tous (auteur, 24 h) et pour moi (`message_hides`).
- Accusés `delivered` / `read` (`message_receipts`), feuille « vu par » en groupe, respect du réglage de confidentialité des accusés.
- Historique paginé (`before/after/limit ≤ 100`), resynchronisation `syncSince` (≤ 500), recherche dans une conversation (médias, liens, documents).
- Groupes ≤ 100 membres, rôles admin/member, permissions `send/add = all|admins`, invites par jeton + QR, demandes de participation.
- Épingler / masquer / couper les notifications d'une conversation ; brouillons E2EE persistés en SQLCipher.
- Connection de conversation : tri des épinglées, filtres tous/non-lus, badge `99+`, actions de swipe (épingler, mute, archiver, masquer, supprimer).

### 1.2 Messagerie chiffrée E2EE
- Noyau Rust `vodozemac` (Olm : X3DH + double ratchet), pickles chiffrés, clés dans l'AndroidKeyStore (AES-256 non exportable), base SQLCipher, médicaments STREAM XChaCha20-Poly1305 pour les fichiers, miniature chiffrée à clé séparée, EXIF retirés des photos, clairs balayés au démarrage/à la déconnexion.
- Versions de payload gelées : `v:1` texte, `v:2` média, `v:3` sticker ; payloads illisibles persistés avec motif normalisé sans perte d'avancée de session.
- Serveur aveugle : clés publiques uniquement, anti-downgrade (refus du clair si `e2eeSince`), `content` forcé à `''`, push générique « Nouveau message », consommation atomique des prekeys (`FOR UPDATE SKIP LOCKED`).
- Accusés affinés au commit `edee675` : « Ouvert » seulement pour les messages réellement visibles à l'écran (50 % de la bulle, 400 ms), « Reçu » lié à la présence du destinataire, accusé de livraison seulement au premier plan ; transfert de texte vers une discussion directe chiffrée, fiche d'informations, « supprimer pour moi ».

### 1.3 Médias et uploads
- `POST /uploads` multipart (plafonds par type, table unique `media-kinds.ts` extension+MIME concordants), écriture atomique `.part-<token>` + rename, idempotence chiffrée avec fencing.
- Service par URL signée HMAC-SHA256 (fenêtre 6 h, `timingSafeEqual`), ciphertext E2EE servi `octet-stream, no-store` avec contrôle d'appartenance.
- Mobile : sélection ≤ 9 fichiers, limites alignées backend (25 Mo image/document, 50 Mo vidéo), vignettes `expo-image` en cache disque, album, visualiseur de documents PDF/texte, progression d'upload.

### 1.4 Appels
- Appels 1:1 (sonnerie 30 s, grâce déconnexion 10 s, message système durée/résultat) et de groupe en maillage (audio ≤ 8, vidéo ≤ 4), WebRTC avec ICE restart, bannière, PiP, historique via messages `call`, push plein écran si hors ligne, `GET /calls/ice-servers` (STUN par défaut, TURN optionnel).

### 1.5 Profils, contacts, présence
- Recherche `ILIKE` pseudo/nom, suggestions (récents + alphabétique, filtre blocage et `discoverability`), blocage bilatéral, confidentialité fine (profil/écriture/groupe/appel/découvrabilité × everyone|contacts|nobody).
- Présence temps réel (heartbeat 60 s, sweep 10 s, 50 abonnements/socket), `lastSeen`, ville géocodée Nominatim sans stockage de coordonnées, mineurs protégés (ville masquée), âge minimum 13 ans.
- Édition du profil (nom, bio, avatar), date de naissance non modifiable, personnalisation de groupe (emoji, couleur, photo).

### 1.6 Notifications et auth
- Push Expo data-only (fan-out matérialisé `message_events`, filtres mute/préférences/heures calmes/blocage, aperçu désactivable, retry 5× backoff).
- JWT access 15 min + refresh opaque rotatif (30 j), bcrypt coût 10, reset 6 chiffres TTL 15 min / 5 tentatives, suppression de compte différée 30 j avec anonymisation, throttle HTTP global et par route, Helmet, CORS allowlist côté HTTP.

### 1.7 Interface
- expo-router (Stack, `typedRoutes`), thèmes clair/sombre (`useTheme`, `ThemedText`, `ThemedView`), matrice de boutons et menus partagés (`ActionSheet`, `BottomSheet`), textes français centralisés pour les écrans refondus (`fr.ts`), `TextScaleProvider`, 311 occurrences d'`accessibility*` dans le code.
- Navigation par notifications : deep-link push vers `/chat/[id]`.

---

## 2. Fonctionnalités manquantes (par domaine, vs références)

Priorités : **P0** = correctif/sécurité ou attendu immédiat, **P1** = fonctionnalité attendue, **P2** = confort.

### Messagerie
| Fonctionnalité | Référence [Doc] | Priorité |
|---|---|---|
| Édition de message (fenêtre + événement `message:edited`) | WhatsApp/Telegram | P1 |
| Transfert en clair (actuellement E2EE uniquement) | WhatsApp (label « Transféré », limite 5 chats) | P1 |
| Sélection multiple (supprimer/transférer en bloc) | WhatsApp | P2 |
| Épinglage de message (bannière, ≤ 3, durées) | WhatsApp (3–4, 24 h/7 j/30 j) | P2 |
| Messages éphémères / disparition auto | Signal (timer), WhatsApp | P2 |
| Sondages | WhatsApp/Telegram | P2 |
| Étoile / messages sauvegardés, export d'historique | WhatsApp/Telegram | P2 |
| Recherche globale (au-delà de la conversation) | WhatsApp/WeChat | P1 |
| Aperçu riche de liens | Messenger/WhatsApp | P1 |
| Réactions unicode arbitraires (actuellement 6 stickers) | Signal/WhatsApp/Telegram | P1 |
| Brouillons serveur (sync multi-appareils) | WhatsApp/Telegram | P2 |

### Réseau social
| Fonctionnalité | Référence [Doc] | Priorité |
|---|---|---|
| Publications / feed chronologique (modèle WeChat Moments : amis uniquement, pas d'algorithme) | WeChat Moments, Instagram | P0 (cadrage) |
| Commentaires (1 niveau de réponse) | Instagram, WeChat Moments | P0 (avec le feed) |
| Statuts / stories 24 h (anneau, réponses en DM) | Instagram, Snapchat, WhatsApp | P1 |
| Abonnements `follows` distincts des amis | Instagram, Snapchat | P1 |
| Canaux publics (non E2EE, décision produit) | WhatsApp, Telegram | P2 |
| Streaks | Snapchat — hors positionnement MboloChat | P2 (déconseillé) |

### Communication
| Fonctionnalité | Référence [Doc] | Priorité |
|---|---|---|
| Appels E2EE (DTLS-SRTP vérifié) | Signal | P1 — autorisation requise (§8) |
| Appels vidéo de groupe au-delà de 4 | Signal (75, non adapté aux Android modestes) | P2 |
| Partage d'écran, appels programmés | Telegram, Messenger | P2 |
| Transcription des messages vocaux | Messenger/WhatsApp (selon pays) | P2 |
| Vitesse de lecture vocale 1,5×/2× | WhatsApp | P1 |

### Interface et navigation
- Onglets bas persistants (Discussions / Appels / Profil) : WhatsApp/Signal les ont ; MboloChat a un Stack seul et `BottomTabInset` défini mais jamais utilisé. P1.
- Deep-links universels (profil, invite, message) : absents. P1.
- Recherche globale, dossiers de discussions, pastilles « mention » : absents. P1.
- Galerie de médias partagés par discussion (au-delà de l'onglet recherche) : absent. P2.

### Backend / plateforme
- Signalement de contenu et file de modération : aucun endpoint `report`. P1.
- Quota de stockage par utilisateur, vignettes serveur, streaming `Range`, scan antivirus : absents. P1/P2.
- TURN à identifiants éphémères (actuellement credential statique) : P1.
- Envoi réel du code de réinitialisation (e-mail/SMS ; le code est loggé), vérification d'e-mail, 2FA : absents. P1 (auth : §8).
- Stockage objet / CDN : assumé absent (disque local). P2 (archi : §8).

### E2EE (toutes : autorisation requise — §8)
- Vérification d'identité hors bande (empreintes/QR/safety number) : absente, `verified` écrit à `true` dès la première vue (trust-on-first-use silencieux).
- Multi-appareil : modèle mono-appareil actuel (révocation des autres appareils à l'enregistrement).
- Groupes chiffrés (Sender Key / MLS), sauvegardes chiffrées, re-déchiffrement d'historique au-delà de 50 messages, appels E2EE, sealed sender (masquage des métadonnées).

---

## 3. Défauts détectés

### 3.1 Sécurité backend
1. **CORS WebSocket `origin: true`** sur les deux gateways (`chat.gateway.ts:41`, `calls.gateway.ts:22`) alors que le HTTP est aligné sur `CORS_ORIGINS` (`main.ts`). **Corrigé pendant la mission (§9)** avec un contrôle `allowRequest` sur tous les transports (vérifié en direct : 403/400 origine étrangère, 101 origine déclarée, 200 mobile).
2. **Avatar et photo de groupe en base64 JSON sans validation d'image** (`users.controller.ts:102-130`, `conversations.service.ts:812`) : MIME déclaré par le client, seul un plafond de 2 Mo pour l'avatar ; un SVG/HTML déguisé peut être stocké et servi signé. Recommandation : contrôle des en-têtes magiques côté serveur, refus des SVG. P0.
3. **Corps bruts non validés** (`@Body() body: {...}`) sur plusieurs routes au lieu de DTO `class-validator` : `displayName`/`bio` non bornés dans `PATCH /users/me`, jeton push non borné, `POST /conversations/:id/photo|members`, `POST /auth/refresh|logout|change-password`. P0/P1.
4. **État 100 % en mémoire** pour appels, présence et rate limits : redémarrage = perte d'état, scaling horizontal impossible, rate limits contournables en multi-instance. À documenter/assumer. P1.
5. `MEDIA_SECRET` optionnel (fallback `JWT_SECRET`), cache `immutable 86400` vs fenêtre de signature 6 h, messages d'erreur socket renvoyés en clair au client, pas de filtre d'exception global ni d'ID de corrélation. P1/P2.

### 3.2 Mobile
1. **Aucune étiquette d'accessibilité sur `conversation-row.tsx`** (ligne de l'écran principal) : corrigé pendant la mission (§9).
2. **Listes `FlatList` sans réglage de performance** (`chats.tsx`, `chat/[id].tsx`, `e2ee-chat/[id].tsx`) : pas de `windowSize`/`maxToRenderPerBatch`/`getItemLayout` → scroll saccadé et RAM élevée sur Android modestes avec 500+ messages. P0.
3. **Dette d'interface chiffrée** : 166 occurrences de couleurs hex/rgba hors thème (`#e5484d` ~20× en destructif, `#ffffff`, `rgba(0,0,0,0.45)`…), 273 dimensions/tailles de police en dur, chaînes hors `fr.ts` y compris des actions destructrices (« Retirer pour tous »). `fr.ts` ne couvre que 9 namespaces ; le reste est en dur. P0 (actions destructrices) / P1 (le reste).
4. **Duplication des pipelines** classique (`chat/[id].tsx`, 3354 lignes) et E2EE (1578 lignes) : chaque correctif accusés/menus/perf se fait deux fois, risque de divergence.
5. **Accessibilité incomplète** : 0 A11y dans 12 fichiers avec Pressable dont `conversation-row` (corrigé), `invite-sheet`, `CallScreen`, `login/register` ; pas de `role="progressbar"` pour les uploads, pas de `maxFontSizeMultiplier`, pas de région live pour « en train d'écrire ». P0/P1.
6. `document-viewer.tsx` (947 lignes, PDF 25 Mo) : risque d'OOM sur appareils modestes ; pas de pagination ni de garde-fou mémoire. P1.
7. Incohérences visuelles : accusés classique (double coche) vs E2EE (« Reçu »/« Ouvert »), trois accents différents selon les écrans, erreurs `#D92D20` (thème) vs `#e5484d` (dur).

### 3.3 E2EE / sécurité
1. Aucune vérification d'identité opérable par l'utilisateur (cf. §2) — MITM possible à la première connexion.
2. Signatures des prekeys non vérifiées côté serveur (`e2ee.service.ts:122-145` : longueur seulement) ; intégrité reposant entièrement sur le client.
3. Clé SQLCipher transitant par JS le temps du `PRAGMA` (risque documenté dans le code).
4. Fonctions JNI « brutes » exposées au JS (écran spike) : à vérifier que l'écran spike n'est jamais embarqué en release.
5. Historique borné à 50 messages au chargement ; perte de clés = perte totale et silencieuse côté pair.
6. `FLAG_SECURE` sur un seul écran, conditionné à un réglage opt-in ; rien sur les appels.

### 3.4 Robustesse
- `registerDevice` révoque tous les autres appareils, sessions et push tokens d'un coup : un changement d'appareil déconnecte tout.
- `search` sans throttle dédié (200/min global) ; `getProfile` expose `age` calculé et `stats.messages`.
- Pas de bandeau/contrôle de lien universel ; `chat-bubble.tsx` : `PanResponder` custom au lieu de `react-native-gesture-handler` (risque de conflit avec `FlatList`).

---

## 4. Améliorations recommandées et architecture

### 4.1 Verrouiller la plateforme (P0, sans autorisation)
1. CORS WS aligné sur `CORS_ORIGINS` — **fait (§9)**.
2. Validation d'image avatar/photo de groupe (magic bytes, refus SVG) : fonction utilitaire `api/src/common/image-signature.ts` + tests ; aucun schéma concerné.
3. DTO `class-validator` pour les corps bruts (`PATCH /users/me`, push-token, `POST /conversations/:id/photo|members`, `POST /auth/refresh`) : bornes de longueur, whitelist ; couverts par les tests existants `ValidationPipe`.
4. Accessibilité : étiquettes sur `conversation-row` (**fait, §9**), puis `CallScreen`, `invite-sheet`, `login/register` ; `role="progressbar"` sur les uploads ; `maxFontSizeMultiplier` fixé.
5. Performance des listes : `windowSize`, `maxToRenderPerBatch`, `getItemLayout` là où les hauteurs sont stables, `React.memo` sur les lignes ; pas de dépendance native (FlashList = autorisation, §8).
6. i18n : déplacer les actions destructrices et menus de `chat/[id].tsx` dans `fr.chat` ; remplacer les couleurs destructrices par le token thème.

### 4.2 Messagerie (P1)
- **Édition de message** : colonne `edited_at` (migration, §8) + événement `message:edited` ; fenêtre d'édition alignée sur la suppression (24 h) ; en E2EE, payload `edit` chiffré (autorisation protocole, §8).
- **Transfert en clair** : recréation d'un nouveau message par destination via l'outbox (nouveau `clientId`), label « Transféré » ; plafond 5 destinations (modèle WhatsApp [Doc]).
- **Recherche globale** : FTS5 dans SQLite côté mobile (zéro coût serveur, compatible E2EE) ; jamais d'indexation de clair côté NestJS.
- **Réactions unicode** : table `message_reactions` existante côté serveur en clair ; en E2EE, payload chiffré (autorisation, §8) ; rate-limit 1 réaction/message/2 s.
- **Vitesse vocale** : `expo-audio` (déjà présent) avec sélecteur 1×/1,5×/2×, aucun changement de format.

### 4.3 Réseau social (P0 cadrage, P1 implémentation)
- **Feed chronologique type WeChat Moments** [Doc] : photos (≤ 9), texte, vidéo courte, audience « amis uniquement » par post, likes/commentaires visibles des seuls amis, pas d'algorithme de recommandation. Tables `posts`, `post_likes`, `comments` (migration, §8) ; pagination par curseur ; vignettes et `expo-image` existants réutilisés.
- **Commentaires** : `comments(post_id, parent_id nullable, body)`, un niveau de réponse, signalement + blocage avant tout lancement public.
- **Stories 24 h** [Doc Instagram/Snapchat/WhatsApp] : table `stories(user_id, media_id, expires_at)`, purge par cron NestJS, anneau UI, réponses = DM avec lien `story_reply_to`. E2EE des stories = décision produit (chiffrement compliquerait la purge serveur).
- **Follows** : table `follows(follower_id, following_id)`, feed = SQL sur les comptes suivis (pas de fan-out).

### 4.4 Communication (P1)
- Fiabiliser l'existant 1:1 avant d'étendre : TURN avec identifiants éphémères (TTL court émis par l'API), plafond SDP, économie de batterie (Opus, vidéo 720p max). Vidéo de groupe plafonnée à 4–8 sur Android modestes (le maillage actuel), pas de SFU sans autorisation (§8).

### 4.5 Performance et Android modestes (transverse, P0)
Bonnes pratiques sourcées : virtualisation obligatoire avec `getItemLayout`/`keyExtractor` stables et `React.memo` (React Native, *Optimizing FlatList*) ; images réduites + `expo-image` cache mémoire/disque + placeholders (Expo Image) ; démarrage allégé avec Hermes et `expo-splash-screen` masqué après init (auth, SQLite, socket) (Expo Splash Screen) ; animations sur le thread UI via `react-native-reanimated` (`transform`/`opacity` uniquement) (Expo Reanimated) ; accessibilité native testée avec TalkBack sur appareil réel (React Native Accessibility) ; annulation des requêtes au démontage et pagination de toutes les listes (guide Performance Expo / FlatList) ; chaque module natif impose un development build validé par `npx expo-doctor` (règle projet : pas de build lourd local).

---

## 5. Dépendances techniques
- Aucune dépendance native nouvelle pour le §4.1–4.2 (validation d'image : détection d'en-têtes en TypeScript pur ; FTS5 : déjà présent via SQLCipher, à confirmer dans le build).
- `expo-image-manipulator`, `expo-audio`, `expo-image` déjà présents.
- FlashList (`@shopify/flash-list`), caméra native, STOCKAGE objet/CDN, SFU, FCM direct : dépendances nouvelles = autorisation (§8).
- TURN : serveur coturn à provisionner (infra, pas de code mobile).

---

## 6. Calendrier de développement par étapes

Chaque étape est indépendante, testée avant la suivante, sans accumulation de modifications non vérifiées.

- **Étape 0 — Verrouillage P0 (sans autorisation)** : fait en partie pendant la mission (CORS WS, étiquettes A11y liste). Reste : validation d'image avatar/photo, DTO des corps bruts, i18n des actions destructrices, tuning `FlatList`, A11y écrans restants. Vérification : `tsc --noEmit`, `expo lint`, Vitest ciblés, e2e API.
- **Étape 1 — Messagerie P1 (migration requise pour l'édition)** : édition de message en clair, transfert en clair, recherche globale FTS5 mobile, vitesse vocale. Vérification : specs Vitest + e2e + test sur appareil (ou Waydroid si un APK est installé).
- **Étape 2 — Réseau social P1 (migration requise)** : `posts`/`comments`/`follows`, feed chronologique, puis stories 24 h. Modération (signalement) avant exposition publique.
- **Étape 3 — Communication P1** : TURN éphémère, durcissement appels 1:1, puis décision produit sur les appels E2EE (autorisation, §8).
- **Étape 4 — Décisions produit** : canaux publics, épinglage E2EE, multi-appareil, groupes E2EE, sauvegarde chiffrée — chacune = autorisation explicite avant tout code.

---

## 7. Fonctionnalités exigeant une autorisation particulière

Arrêt et demande d'accord avant toute implémentation :
- Migration de schéma importante (tables `posts`, `comments`, `stories`, `follows`, `reports`, colonne `edited_at`, quota) : `schema.ts` → `db:generate` → relecture SQL → migration + `meta/_journal.json` (règle AGENTS.md).
- Toute évolution du protocole E2EE, des clés, des payloads ou des migrations cryptographiques : vérification d'identité hors bande, multi-appareil, groupes E2EE, sauvegarde chiffrée, réactions/éditions chiffrées, appels E2EE, sealed sender.
- Authentification : envoi réel du code de reset, vérification d'e-mail, 2FA, révocation de socket immédiate.
- Changement d'architecture majeur : stockage objet/CDN, SFU, queue externe, multi-instance + adaptation Socket.IO, passage FCM direct, onglets + deep-links universels, FlashList (dépendance native), stories (graphe backend + feed).
- Toute suppression de données, modification de compte, modification irréversible, déploiement ou publication.

---

## 8. Améliorations réalisées pendant la mission (non commitées)

Deux correctifs ciblés, réversibles, sans migration, sans toucher au protocole E2EE ni à l'authentification :

1. **CORS WebSocket aligné sur `CORS_ORIGINS`** (P0 backend, §3.1.1)
   - Nouveau `api/src/common/cors.ts` : source unique de la règle d'origine (HTTP + WS), `corsOrigin` et `socketAllowRequest`.
   - Les deux gateways (`chat`, `calls`) utilisent `cors: { origin: corsOrigin, credentials: true }` **et** `allowRequest: socketAllowRequest` : le contrôle `cors` seul ne couvrait que le polling (le transport `websocket` obtenait un 101 même avec une origine interdite — vérifié en direct avant correction).
   - `api/src/main.ts` réutilise `allowedOriginsFromEnv`/`isAllowedOrigin` : une seule implémentation de la règle.
   - Nouveau `api/src/common/cors.spec.ts` (6 tests).
   - Vérification en direct (serveur démarré sur le port 3017, `CORS_ORIGINS=http://localhost:8081`) : polling origine déclarée 200, origine étrangère 403, sans Origin (mobile) 200 ; websocket origine déclarée 101, origine étrangère 400. Sans `CORS_ORIGINS`, toute origine web est refusée (403/400) et le mobile reste accepté — comportement conforme au commentaire de `main.ts` (l'origine web doit être déclarée).
   - Limite : le dialecte d'erreur moteur (400 websocket / 403 polling) est celui d'engine.io ; l'authentification JWT reste exigée après le handshake.

2. **Étiquettes d'accessibilité sur la ligne de discussion** (P0 mobile, §3.2.1)
   - `mobile/src/components/conversation-row.tsx` : `accessibilityRole`, `accessibilityLabel` (nom, aperçu, non-lus, muet/épinglé, horodatage), `accessibilityHint` ; libellés centralisés dans `fr.conversationRow` (`mobile/src/i18n/fr.ts`).
   - Vérification : `tsc --noEmit` mobile OK, `expo lint` sur les fichiers touchés OK, suite Vitest mobile complète : 344 tests passés.

Tests exécutés pendant la mission : API `tsc --noEmit` OK, lint OK (warnings préexistants hors sujet), spec CORS 6/6 ; mobile `tsc --noEmit` OK, lint ciblé OK, 344/344 tests ; handshake Socket.IO réel vérifié par curl (voir ci-dessus). Aucun test visuel Waydroid : session Waydroid en cours d'exécution mais aucun appareil adb attaché, et aucun APK construit (règle : pas de build lourd local ; un test visuel passerait par `npm run build:android` dans Waydroid ou un build EAS).

Fichiers modifiés (non committés, `git status` après mission) :
- `api/src/common/cors.ts` (nouveau), `api/src/common/cors.spec.ts` (nouveau)
- `api/src/chat/chat.gateway.ts`, `api/src/calls/calls.gateway.ts`, `api/src/main.ts`
- `mobile/src/components/conversation-row.tsx`, `mobile/src/i18n/fr.ts`
- `docs/PLAN-DIRECTEUR-AMELIORATION.md` (ce document)

---

## 9. Risques et limites restantes

- L'E2EE reste mono-appareil, sans vérification d'identité opérable, sans groupes chiffrés ni sauvegarde : toute évolution sur ces points exige l'autorisation explicite (§7).
- Le serveur API reste mono-instance (appels, présence, rate limits en mémoire) : ne pas déployer en multi-instance sans adaptation.
- Les doubles pipelines mobile (classique/E2EE) resteront un risque de divergence tant qu'ils ne sont pas rapprochés (refonte = §7).
- Les correctifs de la mission n'ont pas été vérifiés visuellement sur appareil (Waydroid sans appareil adb) ni committés : la revue et le commit restent à la charge de l'utilisateur.
- L'étude comparative s'appuie sur la documentation publique des applications de référence ; les comportements non documentés (détails d'interface internes) n'ont pas été inventés.

---

## 10. Suivi — Phases 2 à 4 et fin de l'Étape 0 (2026-11-09)

Travail réalisé après la rédaction du plan, sans migration, sans modification du protocole E2EE ni de l'authentification. Détail complet dans `docs/UNIFICATION-CHAT-PLAN.md` §9.

- **§4.1.2 — Validation d'image (P0)** : `api/src/common/image-signature.ts` (signatures JPEG/PNG/WebP, base64 strict, extension issue du contenu), avatar et photo de groupe alignés ; parseurs JSON à 3 Mo pour rendre le plafond de 2 Mo atteignable. Tests : spec unitaire 5/5, e2e 9/9.
- **§4.1.3 — DTO des corps bruts (P0/P1)** : `UpdateMeDto`, `RegisterPushTokenDto`/`RemovePushTokenDto`, `AddMembersDto`, `RefreshTokenDto`. Tests : e2e 7/7.
- **§4.1.5 / §4.5 — Performance des listes (P0)** : réglages des trois `FlatList`, callbacks stabilisés, `ChatBubble` mémoïsé, cache disque `expo-image`. Mesure sur appareil non réalisée (aucun appareil adb, conteneur Waydroid arrêté, pas d'APK, build local interdit) ; test de semis `perf-seed` conservé mais ignoré par défaut.
- **§4.1.4 / §4.1.6 — Accessibilité et i18n (P0)** : `fr.chat` pour tous les menus et actions destructrices de l'écran classique ; étiquettes et régions live sur login/register, sélecteur, feuille d'invitation et écran d'appel ; `role="progressbar"` sur les envois ; `maxFontSizeMultiplier` sur les éléments compacts à hauteur fixe.

Vérifications : API `tsc` OK, oxlint 0 erreur (3 avertissements préexistants hors sujet), 112/112 tests unitaires, e2e images 9/9, e2e DTO 7/7 ; mobile `tsc` OK, lint ciblé OK, 344/344 tests. Aucun commit, push ou reset. La Phase 5 de fusion des écrans reste soumise à autorisation explicite (§7).
