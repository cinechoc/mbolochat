# CONCEPTION — Statuts éphémères E2EE (phase 0)

Audit et conception, **aucun code modifié**. Faits observés (section 1) séparés des propositions (section 2). Décisions réservées au propriétaire : section 3.

---

## ⚠ Points bloquants / à signaler (à lire en premier)

1. **Le chiffrement de groupe n'existe pas.** L'E2EE ne couvre que le un-à-un (Olm/vodozemac, une session par pair) ; aucun Megolm/clé d'expéditeur n'est implémenté (`crypto/src/messaging.rs`, `api/src/e2ee/e2ee.service.ts:407-419` limite aux conversations `DIRECT`). Un statut étant une diffusion 1-vers-N, il **faut** une stratégie de clé de contenu distribuée via les sessions 1-1 existantes (voir §2.5, option (a) recommandée). Ce n'est pas un blocage technique, mais c'est la décision structurante du chantier.
2. **Aucun planificateur de tâches** : ni `@nestjs/schedule`, ni node-cron, ni bull. Le code existant utilise des `setInterval` nus (`uploads-retention.service.ts:35`, `account-maintenance.service.ts:14`). L'expiration réelle des statuts exige un job ; proposition en §2.8.
3. **Dépendances natives manquantes pour un éditeur « destructif »** : `react-native-view-shot` et `@shopify/react-native-skia` **ne sont pas installées**. Exporter une image composite (aplatir dessin + texte sur le média) exigerait une dépendance native → build EAS. Le modèle **non destructif** proposé en §2.6 évite toute nouvelle dépendance ; la découpe et la rotation de **vidéo** restent impossibles sans dépendance native (à reporter).
4. **« Contact » n'est pas une table** : c'est « utilisateur partageant au moins une conversation » (`users.service.ts:210-231`). Il n'existe ni amis ni abonnements. La définition d'audience des statuts doit s'appuyer là-dessus (§2.2) — à valider en §3.
5. **Rappel honnête** : le chat classique (`chat/[id].tsx`) est en clair par conception (chemin distinct) ; les statuts, eux, seront chiffrés de bout en bout dès la v1, sans mode dégradé.

---

## 1. Faits observés

### 1.1 Cœur cryptographique (`crypto/`, Rust)

- **vodozemac 0.11.1** (Olm) + `chacha20poly1305` + `aead-stream` + `sha2` + `zeroize` (`crypto/Cargo.toml:15-26`).
- Messagerie (`crypto/src/messaging.rs`) : `create_account` (:57), `generate_one_time_keys` (:75), `create_outbound_and_encrypt` (:110), `encrypt` (:160), `create_inbound_and_decrypt` (:193), `decrypt` (:236), clés pré-signées (:272), **clé de repli (fallback)** signée (:309), vérification de signature Ed25519 sur prékey (:343). Variantes `_with_key` à clé de pickle explicite.
- **Chiffrement de fichiers** (`crypto/src/filecrypto.rs`) : XChaCha20-Poly1305 en flux **STREAM (StreamBE32)** — clé 32 octets, nonce 19 octets, tranches de 256 Kio + tag 16 octets, AAD `mbolo-file-v1` (:15-19) ; retourne `{fileKey, nonce, sha256, plaintextSize, ciphertextSize}` (`models.rs:52-59`) ; le déchiffrement vérifie le SHA-256 du clair (:108-184). Le « morceau par morceau » est interne au flux Rust ; côté JS on chiffre/déchiffre un fichier entier.
- Pont JNI : `crypto/src/jni.rs` (14 fonctions `native*`), `.so` précompilés arm64/x86_64 dans `mobile/modules/mbolo-crypto/android/src/main/jniLibs/`.

### 1.2 Module Expo `mbolo-crypto` et stockage des clés

- API JS (`mobile/modules/mbolo-crypto/src/index.ts:47-101`) : `createAccount`, `generateOneTimeKeys`, `createOutbound`, `encrypt`, `createInbound`, `decrypt`, `encryptFile(inputPath, outputPath)`, `decryptFile(input, output, key, nonce, expectedSha256)`, `selfTest`, `ensureKeys`, `sqlCipherKey`, `verifyPrekey` + variantes `secure*` (la clé de pickle ne traverse jamais le JS).
- **`E2eeKeyStore.kt`** : clé maître AES-256-GCM non exportable `mbolo_e2ee_master_v1` dans **AndroidKeyStore** (:22, :28-43) qui chiffre un blob `{pickleKey, dbKey}` dans SharedPreferences `mbolo_e2ee_keys_v1` (:21, :84-102). Comptes/sessions Olm picklés chiffrés côté Rust ; clé SQLCipher dérivée du `dbKey` (`sqlCipherKeyJson` :124-132). Régénération avec `recovered: true` en cas de perte (:99-101).

### 1.3 Chaîne E2EE mobile (`mobile/src/features/e2ee/`)

- `payload.ts` : enveloppe `v:1` texte `{v, text, replyTo?}` (:89-91) et `v:2` média `{v, kind:'media', media, caption, replyTo?}` (:94-98) ; `EncryptedBlob = {uploadId, fileKey, nonce, sha256, size}` (:17-28) ; `EncryptedMedia` (type IMAGE/VIDEO/AUDIO/FILE, mime, dimensions, durée, waveform, blob, thumb) (:31-48) ; `parsePayload` rejette les versions inconnues (:149-177).
- `text.ts` : envoi direct par socket `message:send` avec `encryption:'v1'`, `payload`, `payloadType:'prekey'|'normal'`, `clientId` idempotent, ack 15 s (:180-189) ; réutilisation de session sinon consommation prekey/fallback + `verifyPrekey` + `secureCreateOutbound` (:59-140) ; `decryptIncoming` gère prekey/absence de session et détection de changement de clé (:219-360).
- `media.ts` (**pipeline réutilisable**) : plafonds clair côté appareil (image 10 Mo, vidéo 40 Mo, fichier 25 Mo, audio 15 Mo, :30-35) ; photos ré-encodées JPEG ≤1600 px **EXIF retiré** (`reducePhoto` :82-96) ; vignette ≤320 px (:99-121) ; `encryptBlob` → `MboloCrypto.encryptFile` (clé+nonce aléatoires par blob, média et vignette séparés) (:124-132) ; **téléversement du chiffré** `application/octet-stream` + `encrypted: true` + `conversationId` (:205-221) ; enveloppe v2 contenant les clés (:224-250) ; nettoyage du répertoire intermédiaire en `finally` (:295-298).
- `mediaStore.ts` : téléchargement via `GET /uploads/:id` puis `decryptFile` (vérif SHA-256), clair stocké dans le répertoire privé `mbolo-e2ee-media`, purgé par `closeMedia`/`sweepSecureMedia` (:118-166) ; vignettes déchiffrées en data URI éphémère (:180-203).
- `db.ts` : SQLCipher `mbolo-e2ee.db` (clé = `PRAGMA key x'…'`, :58-66) ; tables `e2ee_account`, `e2ee_sessions`, `e2ee_peer_keys`, `e2ee_messages` (avec `media_meta`, `quote_id`), `e2ee_drafts` (:89-143).
- `bootstrap.ts` : création de compte + 5 OTK signées + fallback, publication `POST /e2ee/devices`, recharge `POST /e2ee/devices/prekeys` sous 5 (:32-112).

### 1.4 Ce qui est chiffré aujourd'hui — et ce qui ne l'est pas

| Contenu | État |
| --- | --- |
| Texte 1-1 (écran `e2ee-chat/[id].tsx`) | **Chiffré** (Olm v1) |
| Photos / vidéos / documents / notes vocales 1-1 | **Chiffrés** (pipeline §1.3, `E2eeMediaKind` inclut `audio`, envoi vocal `e2ee-chat/[id].tsx:493-502`) |
| Groupes | **NON chiffrés** — serveur limité aux `DIRECT` (`e2ee.service.ts:407-419`, `conversations.service.ts:1767-1772`) |
| Chat classique (`chat/[id].tsx`, groupes) | En clair par conception ; les DIRECT éligibles redirigent vers l'écran E2EE (`chat/[id].tsx:2696-2706`) |
| Activation | API : `E2eeService.assertEnabled()` sur chaque route + auto-bascule `e2eeSince` ; mobile : `EXPO_PUBLIC_E2EE_ENABLED === '1'` (`policy.ts:2-6`) |

### 1.5 Envoi et stockage des médias (serveur)

- `POST /uploads` (multipart, JWT, `@Throttle` 30/min) : multer mémoire, `MAX_UPLOAD_BYTES = 50 Mo`, `MAX_ENCRYPTED_BYTES = 60 Mo` (`uploads.service.ts:18,25`), plafonds par type (:27-37), liste blanche mime+extension (`media-kinds.ts:23-84`).
- Deux modes (`uploads.controller.ts:70-85`) : clair (servi signé) et E2EE (`encrypted=1` + `conversationId` + `kind`, adhésion vérifiée `uploads.service.ts:144-146`, extension `.bin`).
- Disque : `uploads/<AAAA>/<MM>/<uuid><ext>` (`uploads.service.ts:322-331`), créé au démarrage (`main.ts:73-74`).
- Service : clair via `GET /media?f=&e=&s=` signé HMAC (fenêtre 6 h, `media.service.ts:19,51-60`) ; **chiffré** via `GET /uploads/:id` (JWT + adhésion via `upload_conversations`, `no-store`, `uploads.controller.ts:94-126`).
- Suppression : « supprimer pour tous » = suppression logique du message, **le fichier reste** ; seul `UploadRetentionService` purge les blobs E2EE > 30 j, toutes les heures par `setInterval` (`uploads-retention.service.ts:19,35,53`). Aucun nettoyage des orphelins clairs.
- Avatar : `POST /users/me/avatar` en base64 JSON ≤ 2 Mo (`users.controller.ts:102-140`).

### 1.6 Contacts, blocage, groupes

- **Pas de table d'amis** : « contact » = partage d'au moins une conversation (`users.service.ts:210-231`, `presence-visibility.ts:29-31`).
- `blocks` (blockerId, blockedId, cascade, PK double) — `schema.ts:218-230`.
- `conversations.type = 'DIRECT' | 'GROUP'` (:17), `conversation_members` (PK double, rôle admin/member) (:125-147).
- `messages` : `encryption`, `payload`, `payloadType`, `senderDeviceId`, `attachment` jsonb, `encryptedAttachment {uploadId}`, `clientId` (unicité expéditeur+clientId), **`replyToId` (colonne texte sans clé étrangère — fuite de métadonnées si on l'utilise en E2EE)**, `deletedAt` (:363-417). `message_receipts` (lu/livré) (:424-440).
- Migrations : drizzle-kit, `npm run db:generate`, application au démarrage (`main.ts:96-97`), 33 migrations dans `api/drizzle/`.

### 1.7 Temps réel, planification, notifications

- Socket.IO : `api/src/chat/chat.gateway.ts` (namespace `/`), **auth JWT dans le handshake** (`socket-auth.ts:12-25`, déconnexion sinon) ; pièces `conv:<id>` et `user:<id>` ; événements message:send/ack/react/delete/read/typing/presence. Passerelle appels séparée, même auth.
- **Aucun planificateur** : `@nestjs/schedule`, node-cron, bull — absents. Précédents de tâches périodiques : `setInterval` horaire (rétention uploads, maintenance comptes), balayage de présence.
- **Push : oui, via l'API HTTP Expo** (`push.service.ts:21-23`, lots de 100, données only rendues par l'app Android), déclenchée sur message/réaction/appel. **Les statuts n'enverront pas de notification** (spec).
- Limites : throttler global 200/min + par route (uploads 30/min, médias 600/min), limiteur socket en mémoire (messages 30/60 s), Helmet, CORS par liste (`app.module.ts:24-47`, `main.ts:32-58`).

### 1.8 Mobile

- **Navigation** : une seule pile racine, **pas d'onglets** (`_layout.tsx:147-171`) ; atterrissage `/chats` (`index.tsx:20`) ; `chats.tsx` = en-tête personnalisé + recherche + onglets de filtre + `FlatList` de `ListRow`/`SwipeableRow` ; superpositions globales montées hors navigateur (appels, notifications) (`_layout.tsx:44-66`).
- **Bibliothèques** (mobile/package.json) : `expo-image-picker ~58.0.10` ✅, `expo-image-manipulator ~58.0.16` ✅, `expo-camera ~58.0.14` ✅, `expo-video ~58.0.13` ✅, `expo-audio ~58.0.10` ✅ (pas expo-av), `react-native-svg 15.16.0` ✅, `react-native-gesture-handler ~3.3.0` ✅, `react-native-reanimated 4.7.1` ✅, `expo-video-thumbnails ~58.0.2` ✅, `expo-secure-store ~58.0.2` ✅, `expo-sqlite ~58.0.14` ✅, `expo-haptics ~58.0.7` ✅. **Absentes** : `react-native-view-shot`, `@shopify/react-native-skia`, `expo-media-library`, `expo-screen-orientation`.
- **Thème/i18n** : jetons `Colors.light/dark`, `Spacing`, `Radii`, `Type` (`constants/theme.ts:14-130`) ; palette chat WeChat `useChatColors()` (`constants/chat-theme.ts`) ; `useTheme()` (`hooks/use-theme.ts:4-7`) ; textes **import direct** `fr.settings.x` depuis `src/i18n/fr.ts` (objet imbriqué, pas de framework) ; `ThemedText`/`ThemedView`.
- **Composants réutilisables** : `avatar.tsx` (size/shape circle|rounded/variant) ; sélection de médias `features/media/pickMedia.ts` (ImagePicker + document-picker) ; panneau emoji/stickers/GIF `features/emoji/EmojiStickerPanel.tsx` + bibliothèque de stickers locale (`features/stickers/stickerLibrary.ts`, AsyncStorage) ; visionneuses **maison** `features/media/MediaViewers.tsx` (Modal + pagination + expo-image / expo-video `useVideoPlayer`) ; `swipeable-bubble.tsx`, `quote-block.tsx`, `voice-recorder.tsx`, `attach-panel.tsx`, `action-sheet.tsx`, `choice-sheet.tsx`, `bottom-sheet.tsx`.
- **Données** : `lib/api.ts` (client fetch + ApiError), `lib/socket.ts`, **outbox SQLite** (`lib/outbox.ts` + `store.ts`, `clientId` idempotent, reprise hors ligne) — chemin **classique uniquement** ; `lib/app-preferences.ts` (AsyncStorage, blob JSON typé, `useAppPreference`) ; `lib/config.ts` (API_URL).
- **Stockage sécurisé** : `expo-secure-store` pour les jetons (`lib/token-storage.ts:4-5`) ; clés E2EE dans le Keystore Android via `E2eeKeyStore` (§1.2).
- **Caméra** : permissions demandées ponctuellement (`launchCameraAsync` dans les écrans chat, `CameraView` réservé aux appels) ; aucun écran de capture dédié.

---

## 2. Conception proposée

> Chaque point : 2 options maximum, recommandation en gras, risques. Aucune nouvelle primitive cryptographique : tout réutilise Olm (sessions 1-1) + `encryptFile`/`decryptFile` (XChaCha20 STREAM).

### 2.1 Placement dans l'application

- **A. Rangée en haut de `chats.tsx`** (« Mon statut » + avatars à anneau, comme WhatsApp) : aucune refonte de navigation (l'app n'a pas d'onglets), accès immédiat, la visionneuse et l'éditeur s'empilent au-dessus.
- B. Onglet dédié : impliquerait d'introduire un système d'onglets inexistant — refonte de `_layout.tsx` et de tous les écrans racine.
- **Recommandation : A.** Risques : `chats.tsx` est déjà dense → extraire la rangée dans `features/statuses/StatusRow.tsx` pour ne pas grossir l'écran ; défilement horizontal à soigner (reactCompiler : pas de mutation d'état).

### 2.2 Modèle de données (PostgreSQL/Drizzle)

Tables nouvelles (toutes les clés étrangères `on delete cascade`, sauf mention) :

- **`statuses`** : `id` uuid PK, `author_id` → users (cascade), `kind` enum `TEXT|IMAGE|VIDEO`, `caption` **absent** (la légende voyage chiffrée dans le blob), `media_upload_id` → uploads (null pour TEXT, `on delete set null` + colonne `media_removed`), `thumb_upload_id` → uploads (nullable), `duration_ms` (vidéo), `bg` (couleur de fond texte, référence de palette — pas de valeur libre), `created_at`, `expires_at` (indexé), `view_receipts_enabled` boolean. Index : `(author_id, expires_at)`, `(expires_at)` pour le job.
- **`status_audience`** (audience figée **et** distribution de clé) : `status_id` → statuses (cascade), `user_id` → users (cascade), `wrapped_key` text (enveloppe Olm 1-1 de la clé de contenu, base64). PK `(status_id, user_id)` ; **index sur `user_id`** pour « les statuts que je peux voir ».
- **`status_views`** : `status_id` → statuses (cascade), `user_id` → users (cascade), `viewed_at`. PK `(status_id, user_id)` ; index `(status_id)` pour « vu par ».
- **`status_privacy`** : `user_id` PK → users (cascade), `mode` enum `CONTACTS|CONTACTS_EXCEPT|ONLY`, `receipts_enabled` boolean.
- **`status_privacy_exceptions`** : `user_id`, `target_id` → users (cascade), PK double. Sens dérivé du mode (exclusion ou inclusion).
- **`status_mutes`** : `user_id` (celui qui sourdine), `muted_id`, PK double — pas de cascade vers statuses (indépendant des statuts).

Requêtes de la liste : `statuses JOIN status_audience (user_id = moi) WHERE expires_at > now()` + anti-jointures blocage/sourdine + agrégat « non vu » via `status_views`. L'audience figée est garantie par l'instantané `status_audience` écrit à la publication.

- Alternative envisagée : une seule table avec `audience jsonb` — rejetée (pas de clé étrangère, jointures impossibles, lignes volumineuses).
- **Risques** : volume `status_audience` (N lignes par statut) — plafonner l'audience (§3) ; `replyToId` existant sans FK ne doit **pas** être utilisé pour les statuts (métadonnée côté serveur interdite).

### 2.3 API (toutes sous `JwtAuthGuard`, préfixe `/statuses`)

| Méthode & chemin | Droits | Remarques |
| --- | --- | --- |
| `POST /statuses` | auteur authentifié | Corps : kind, uploadId(s), durée, bg, `audience: [{userId, wrappedKey}]` ; serveur vérifie que chaque destinataire est un « contact » non bloqué au sens du mode de confidentialité ; plafonds (taille audience, nb/jour) ; `expires_at = now + TTL` |
| `GET /statuses` | moi | Liste groupée par auteur : mes statuts + ceux dont je suis dans l'audience, `expires_at > now()`, avec **mon** `wrappedKey`, état « non vu » ; pagination par curseur `created_at` |
| `GET /statuses/:id` | membre de l'audience (ou auteur) | Métadonnées + mes clés enveloppées ; **jamais** le contenu en clair |
| `GET /statuses/:id/media` | membre de l'audience | Flux du chiffré depuis le disque (`no-store`), contrôle audience + blocage à chaque requête |
| `POST /statuses/:id/view` | membre de l'audience | Upsert `status_views` (idempotent) |
| `GET /statuses/:id/views` | **auteur seul** | Liste des visionneurs + horodatages, seulement si `view_receipts_enabled` |
| `DELETE /statuses/:id` | **auteur seul** | Supprime lignes (cascade) + fichiers disque |
| `GET|PUT /statuses/privacy` | moi | Mode + exceptions + accusés de lecture |
| `POST|DELETE /statuses/:id/mute` | moi | Sourdine d'un contact |

Limitation de débit : création 30/h (throttler par route), vues 600/min, liste 60/min — valeurs en configuration. Pas de `replyToId` ni d'identifiant de statut exposé dans les messages classiques (cf. §2.7). **Risque** : énumération d'identifiants → réponses 404 uniformes (pas 403) sur `:id` hors audience.

### 2.4 Médias

- **Téléversement** : réutiliser `POST /uploads` avec un nouveau `kind: 'STATUS'` (chiffré, `application/octet-stream`, plafond chiffré 60 Mo) ; pas de `conversationId` — l'autorisation d'écriture = auteur. Le service `GET /uploads/:id` existant refusera ces blobs (pas de ligne `upload_conversations`) : défense en profondeur, le téléchargement passe par `GET /statuses/:id/media`.
- **Durée de vie** : `STATUS_TTL_HOURS = 24` (config). **Nettoyage** : job (§2.8) qui supprime lignes + fichiers ; **envois jamais publiés** : `uploads` de kind STATUS sans `statuses` référent, purgés après un délai de grâce (`STATUS_UNPUBLISHED_GRACE_HOURS = 24`).
- **Plafonds par défaut (tous en configuration `statuses.config.ts` + variables d'environnement)** : TTL 24 h ; vidéo **≤ 30 s** et ≤ 30 Mo chiffrés ; image ≤ 10 Mo clair (ré-encodée comme en chat) ; texte ≤ 2 000 caractères ; **20 statuts/24 h par auteur** ; audience ≤ 200 personnes ; vignette ≤ 320 px.
- **Risques** : fichier géant → plafond multer + plafond métier ; disque → le job purge réellement (`unlink` puis suppression de ligne).

### 2.5 Chiffrement des statuts — comparaison sur le module existant

Clé de contenu : 32 octets aléatoires par statut ; contenu (média **ou texte**) chiffré via `encryptFile` (XChaCha20 STREAM, SHA-256) ; vignette chiffrée séparément (pipeline exact du chat E2EE).

| Critère | (a) clé par statut, enveloppée par destinataire | (b) clé d'expéditeur « statuts » à chaîne |
| --- | --- | --- |
| Coût publication 20 / 200 / 1000 | 20 / 200 / 1000 `secureEncrypt` (~1-2 ms chacun → ≤ 2 s à 1000) + ~150 o par enveloppe | 1 chiffrement local + avance de chaîne ; distribution initiale : 1 `secureEncrypt` par contact |
| Contact ajouté après publication | N'est **pas** dans l'instantané → ne voit pas (conforme à l'audience figée) | Doit recevoir l'état de chaîne courant (1 chiffrement) — cas spécial à gérer |
| Contact bloqué/retiré | Clé déjà remise non révocable (limite honnête) ; le serveur cesse de servir le fichier (contrôle à chaque requête) | Idem + il conçoit la chaîne jusqu'à expiration |
| Appareil hors ligne | Les clés enveloppées dorment côté serveur, récupérables au retour — **aucune dépendance temporelle** | Rattrapage de chaîne nécessaire (conserver toutes les clés intermédiaires = (a) déguisé) |
| Compatibilité code | **Totale** : `secureEncrypt`/`secureDecrypt` + `encryptFile`, zéro nouveau schéma cryptographique | Exige un protocole de chaîne (hachage/ratchet) nouveau — contredit « n'invente aucune cryptographie » |
| Métadonnées serveur | N enveloppes opaques par statut (taille ~150 o × N) | 1 clé au départ, puis rien |

- **Recommandation : (a).** Linéaire en taille d'audience mais sans état, rétro-compatible, conforme à l'audience figée et à la reprise hors ligne ; le plafond d'audience (200) borne le coût. Le texte des statuts TEXT suit le même chemin (blob chiffré minuscule) : le serveur ne voit **aucun** clair, même pour les statuts texte.
- **Risques de (a)** : latence de publication pour de très grandes audiences (mitigé par le plafond) ; taille de la ligne `POST /statuses` (200 enveloppes ≈ 30 Ko — sous la limite 64 Ko des payloads socket, et ici en HTTP).
- **Risques de (b)** : nouvelle logique protocolaire à tester, cas hors ligne non trivial, bénéfice nul sous 200 destinataires.

### 2.6 Éditeur (modèle non destructif)

Modèle : média d'origine (préparé : ré-encodage image comme `reducePhoto`, vidéo bornée à l'enregistrement) + liste d'éléments `{type: text|emoji|sticker|stroke, x, y, scale, rotation, color, size, text|stickerRef|points[]}` en **coordonnées relatives 0-1** dans un cadre 9:16, sérialisés **dans l'enveloppe chiffrée** du statut (champ `overlays`), re-rendus par la visionneuse.

- **Réalisable sans nouvelle dépendance** : déplacement/pincement (gesture-handler + reanimated ✅), texte et emoji (vues RN), stickers (référence de catalogue, rendu `StickerView` existant), tracés de dessin (`react-native-svg` ✅ — polylignes lissées), recadrage et rotation d'**image** (`expo-image-manipulator` ✅, appliqués une fois à la préparation), capture photo/vidéo (`expo-camera` ✅, `maxDuration` pour borner la vidéo), vignette (`expo-video-thumbnails` ✅).
- **Exigerait une dépendance native (donc build EAS) — à reporter** : découpe de vidéo (trim), rotation/recadrage de **vidéo**, filtres/effets, export aplati (view-shot/skia). La visionneuse re-rend les superpositions : aucun aplat n'est nécessaire.
- **Recommandation : ce modèle.** Risques : fidélité du rendu éditeur↔visionneuse (même composant de rendu partagé aux deux endroits, tests de normalisation des coordonnées) ; taille de l'enveloppe avec les tracés (plafond `overlays` en config, ex. 32 Ko).

### 2.7 Réponses et réactions

- **Réponse privée** : message chiffré 1-1 existant, avec une **variante d'enveloppe dédiée** (`v:3` `{kind:'status_reply', statusId, statusAuthorId, preview, text}`) envoyée via le chemin `text.ts` (socket `message:send`, `clientId`). L'aperçu du statut voyage **dans** l'enveloppe : le serveur n'apprend rien (jamais `replyToId`). La conversation DIRECT auteur↔visionneur existe déjà dans la plupart des cas (audience = contacts) ; si elle n'existe pas, la créer via l'API existante avant l'envoi.
- **Réaction rapide** : même canal, enveloppe `v:3` `{kind:'status_reaction', emoji, statusId}` — arrive dans la conversation 1-1, comme WhatsApp. Aucune table serveur de réactions aux statuts.
- **Risques** : `parsePayload` actuel rejette les versions inconnues → ajouter `v:3` sans toucher v1/v2 (anciens clients : erreur affichée proprement, jamais de crash) ; ne pas réutiliser `replyToId`.

### 2.8 Expiration

- **Recommandation : service `StatusRetentionService` sur le modèle `UploadRetentionService`** : `setInterval` (60 s, config) + exécution au démarrage (rattrape l'arrêt de l'API : tout statut expiré pendant l'indisponibilité est purgé à la remontée). Idempotent : `DELETE FROM statuses WHERE expires_at <= now() RETURNING media_upload_id, thumb_upload_id` → `unlink` des fichiers **d'abord**, puis suppression des lignes d'uploads ; un crash entre les deux laisse un fichier orphelin repris par la rétention existante (30 j). En complément, **toutes** les requêtes de lecture filtrent `expires_at > now()` : rien n'est servi en retard même si le job traîne.
- Alternative : `@nestjs/schedule` (dépendance standard) — rejetée en v1 pour rester cohérent avec les deux services existants et zéro dépendance.
- **Risques** : fichiers non supprimables (permissions) → journaliser sans contenu, retenter au tick suivant ; horloge → toujours comparer en UTC côté base.

### 2.9 Menaces et parades

| Menace | Parade |
| --- | --- |
| Accès à un statut d'un autre | Contrôle d'audience sur chaque lecture (`:id`, `/media`, `/views`) ; 404 uniforme ; aucune énumération |
| Énumération d'identifiants | UUID v4 ; pas de compteurs ; 404 identique « introuvable/hors audience » |
| Abus d'envoi / fichier géant | Throttler par route + plafonds config (nb/jour, taille, durée, taille d'audience) |
| Contact bloqué | Vérification `blocks` à la publication **et** à chaque lecture ; il cesse de voir le fichier, mais la clé déjà remise n'est pas révocable (documenté) |
| Audience modifiée après coup | Instantané `status_audience` ; aucune route de modification d'audience |
| Métadonnées d'image (GPS, appareil) | EXIF retiré à la préparation (`reducePhoto` existe) **avant** chiffrement |
| Brouillon en clair sur l'appareil | Brouillon en mémoire uniquement, média d'attente dans le répertoire privé déjà balayé par `sweepSecureMedia` ; confirmation avant abandon |
| Journaux | Rien de clair ni de clé dans les logs (règle AGENTS.md) ; le serveur ne reçoit que du chiffré + métadonnées acceptées (auteur, horaires, taille, audience, vues) |
| Capture d'écran / enregistrement par un destinataire | Indéjouable — mentionné dans la doc et l'interface (limites honnêtes) ; FLAG_SECURE reste un atténuateur local |

### 2.10 Découpage des fichiers

```
api/src/statuses/
  statuses.module.ts            # wiring + providers
  statuses.controller.ts        # routes §2.3
  statuses.service.ts           # règles métier, audience, vues
  statuses-retention.service.ts # expiration (§2.8)
  statuses.config.ts            # TTL, plafonds, throttles (config seule)
  dto/                          # validation class-validator

mobile/src/features/statuses/
  client.ts                     # appels API typés (ou extension lib/api.ts)
  keys.ts                       # génération clé de contenu, wrap/unwrap Olm
  model.ts                      # types partagés (StatusItem, Overlay…)
  list/                         # rangée chats.tsx, regroupement par auteur, anneau
  viewer/                       # visionneuse plein écran (barres, tap, pause)
  editor/                       # éditeur non destructif (§2.6) + rendu partagé
  overlay-render.tsx            # rendu commun éditeur/visionneuse des superpositions
  privacy.ts                    # écran réglages + exceptions
mobile/src/app/
  status-editor.tsx             # routes expo-router (pile racine)
  status-viewer.tsx             # (paramètres par route, pas d'URL de contenu)
```

Conformité : logique dans `features/`, routes dans `app/`, textes dans `i18n/fr.ts`, couleurs via `theme.ts`/`chat-theme.ts`, serveur = autorité d'autorisation.

---

## 3. Questions à trancher (recommandation entre parenthèses)

1. **Définition d'audience** : « mes contacts » = utilisateurs partageant au moins une conversation avec moi (définition existante), hors bloqués — ou restreindre aux conversations **DIRECT** uniquement ? (Reco : partage de conversation quelconque, hors bloqués ; plus fidèle à « contacts ».)
2. **Réactions** : via la conversation 1-1 chiffrée (aucune table serveur) ou table serveur `status_reactions` ? (Reco : conversation 1-1, zéro métadonnée de plus, cohérent avec la réponse privée.)
3. **Réponse à un statut sans conversation DIRECT existante** : créer automatiquement la conversation 1-1, ou masquer le bouton « Répondre » dans ce cas ? (Reco : création automatique — l'audience est déjà constituée de contacts.)
4. **Accusés de lecture** : réciprocité complète dès la v1 (si je désactive, je ne vois pas qui a vu les miens) ou accusés toujours actifs en v1 ? (Reco : réciprocité dès la v1 — la colonne `view_receipts_enabled` est de toute façon prévue.)
5. **Plafond d'audience par statut** : 200 ? (Reco : 200, configurable ; borne le coût de publication de l'option (a).)
6. **Vidéo** : reporter découpe/rotation (dépendance native, build EAS) et borner à 30 s à l'enregistrement — ou intégrer la dépendance native dès maintenant ? (Reco : reporter ; l'éditeur reste 100 % sans nouvelle dépendance.)
7. **Statuts texte** : palette de fonds fixe (quelques couleurs du thème) ou sélecteur libre ? (Reco : palette fixe dérivée du thème, clair/sombre — cohérence visuelle et zéro upload de ressource.)
8. **Emplacement des réglages de confidentialité des statuts** : sous `settings/privacy.tsx` (section dédiée) ou écran séparé `settings/status-privacy.tsx` ? (Reco : écran séparé lié depuis privacy et depuis la rangée « Mon statut ».)
