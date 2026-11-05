# M3 — Médias chiffrés de bout en bout : commandes de preuve

Ce document donne les commandes à exécuter **telles quelles** (sans redirection
ni tube, comme le §4 du compte-rendu) pour prouver que le clair d'un média ne
survit nulle part, et le résultat du repérage des formulations interdites.

Paquet : `com.groupenzogho.mbolochat`. Canari : `MBOLO-CANARY-M3`, placé dans le
fichier envoyé comme média (photo, document ou vocal).

## 1. Contrôle positif — pendant la lecture

Ouvrir le média dans la conversation chiffrée, **pendant** que la visionneuse
est affichée, puis lancer :

    adb shell run-as com.groupenzogho.mbolochat grep -rla MBOLO-CANARY-M3 /data/data/com.groupenzogho.mbolochat

- **succès attendu** : un seul chemin, sous
  `files/mbolo-e2ee-media/<uploadId>/plain.<ext>` — le clair temporaire de la
  lecture en cours. Cette sortie prouve que la sonde est capable de trouver le
  canari sur le disque (sans elle, un « aucune sortie » plus bas ne prouverait rien).
- **défaut** : aucune sortie (le média n'était pas ouvert, ou la sonde est aveugle) ;
  ou plusieurs chemins (une copie claire traîne ailleurs).

## 2. Après fermeture du média

Fermer la visionneuse (bouton « Fermer le média » ou retour), puis relancer :

    adb shell run-as com.groupenzogho.mbolochat grep -rla MBOLO-CANARY-M3 /data/data/com.groupenzogho.mbolochat

- **succès attendu** : **aucune sortie**.
- **défaut** : un chemin subsiste → le clair n'est pas effacé à la fermeture.

## 3. Après redémarrage

Forcer l'arrêt, relancer l'app, rouvrir la conversation, relancer :

    adb shell am force-stop com.groupenzogho.mbolochat

    adb shell run-as com.groupenzogho.mbolochat grep -rla MBOLO-CANARY-M3 /data/data/com.groupenzogho.mbolochat

Puis vérifier qu'aucun reste du dossier temporaire ne subsiste :

    adb shell run-as com.groupenzogho.mbolochat ls -R files/mbolo-e2ee-media

- **succès attendu** : `grep` → **aucune sortie** ; `ls` → dossier inexistant ou vide.
- **défaut** : une sortie de `grep`, ou un fichier sous `mbolo-e2ee-media/`.

## 4. État normal — drapeau actif, aucun média ouvert

Sans ouvrir de média, dans l'app au repos :

    adb shell run-as com.groupenzogho.mbolochat grep -rla MBOLO-CANARY-M3 /data/data/com.groupenzogho.mbolochat

- **succès attendu** : **aucune sortie**.
- **défaut** : un chemin apparaît.

## 5. Rappel — le ciphertext, lui, est bien sur le disque de l'app

Le média chiffré n'a pas à être caché côté client : c'est un blob opaque. Le
contrôle qui compte est l'absence de **clair** (points 1 à 4), pas l'absence de
fichier. Le ciphertext téléchargé vit dans
`files/mbolo-e2ee-media/<uploadId>/cipher.bin` **le temps de la lecture**, et
disparaît comme le clair à la fermeture.

## 6. Repérage des formulations interdites

Règles verrouillées : drapeau désactivé par défaut ; aucun libellé « chiffré de
bout en bout » visible ; aucun texte ne promet « aucun clair sur le téléphone ».

Repérage exécuté sur `mobile/src` (hors `e2ee-dev`, écran de développement) :

    grep -rniE "aucun clair|pas de clair|jamais en clair|clair sur (le|ton) téléphone" mobile/src --include=*.ts --include=*.tsx

- **résultat** : les seules occurrences sont des **commentaires de code**
  (`e2ee-chat/[id].tsx` deux fois — `FLAG_SECURE` et fermeture des médias ;
  `SecureMediaMessage.tsx` une fois — libération au démontage) qui décrivent le
  comportement interne. Aucune chaîne affichée à l'utilisateur ne porte cette
  formulation. Les libellés d'interface M3 (`fr.e2eeMedia`, `fr.e2ee.*`) parlent
  d'« ouverture », de « fermeture », d'« aperçu » — jamais de garantie sur le
  téléphone.

    grep -rniE "bout en bout|end-to-end" mobile/src/i18n/fr.ts

- **résultat** : `securitySection: 'Chiffrement de bout en bout'` — libellé
  **préexistant à M2** (présent dans `HEAD`, `git show HEAD:mobile/src/i18n/fr.ts`
  ligne 36), dans la section Réglages → Sécurité et affiché seulement quand le
  drapeau est actif. Les textes ajoutés par M3 n'introduisent aucune nouvelle
  mention. Le libellé reste à revoir avec la décision produit sur la formulation,
  hors périmètre M3.

    grep -rniE "bout en bout" mobile/src/app/settings/help.tsx

- **résultat** : phrase **préexistante à M2** (présente dans `HEAD`) :
  « Le chiffrement de bout en bout arrive dans une prochaine version. » Elle
  annonce la fonctionnalité, elle ne la promet pas comme active. Inchangée par M3.

## 6bis. Drapeaux désactivés par défaut

    grep -n "EXPO_PUBLIC_E2EE_ENABLED" mobile/src/features/e2ee/policy.ts

- **résultat** : `flag === '1'` — tout autre valeur (absente, `0`, `true` sans
  guillemets côté mobile) laisse le chiffrement coupé.

    grep -rn "E2EE_ENABLED" api/src/

- **résultat** : `assertEnabled()` (et les gardes `main.ts`, `chat.gateway.ts`,
  `conversations.service.ts`) n'acceptent que `1` ou `true` ; `api/.env` porte la
  valeur de test. Les fichiers `mobile/.env` et `api/.env` sont **ignorés par
  git** (règle `.env` du `.gitignore` racine, `git check-ignore` le confirme) :
  aucune build de production ne les embarque.

## 7. Vérifications automatisées (rejouées)

Résultat du dernier passage, sur la branche `feat/e2ee-m2-text` :

- **Mobile** — `npx vitest run` (dépôt entier) : **15 fichiers, 94 tests, 0 échec**.
  Dont, dans `src/features/e2ee` :
  `payload.test.ts` (v1/v2, refus de version, `media_meta`),
  `mediaStore.test.ts` (téléchargement/déchiffrement, **aucun reste** en cas
  d'échec, refus d'un identifiant hors dossier, balayage),
  `media.test.ts` (ordre chiffrer → téléverser → envoyer, deux blobs en
  `encrypted=1&conversationId`, zone de travail effacée en succès **et** en échec),
  `mediaPolicy.test.ts` (vignette auto selon réseau/réglage, et classification du
  réseau annoncé par la plateforme : Wi-Fi / cellulaire / filaire-VPN-inconnu /
  hors ligne), `text.test.ts` (non-régression M2).
- **API** — `npx vitest run --config ./vitest.config.e2e.ts test/e2ee-media.e2e-spec.ts` :
  **8 tests, 0 échec** — lien fichier↔conversation, 200 membres / 404 non-membres /
  404 id clair, **refus d'une pièce jointe en clair dans un message chiffré (400 +
  404 au téléchargement)**, refus d'une pièce jointe d'une autre conversation,
  exclusion de la galerie (`listMedia`), purge par rétention, refus d'import par un
  non-membre. Non-régression M2 : `test/e2ee.e2e-spec.ts` → **8 tests, 0 échec**.
- **API (unitaire)** — `npx vitest run` : **15 fichiers, 96 tests, 0 échec**, dont
  `test/push-e2ee.spec.ts` (l'aperçu de notification ne révèle rien d'un message
  chiffré).
- **Rust** — `cargo test` dans `crypto/` : **12 tests** du noyau (+ 6 de vecteurs
  libolm/RFC 8032), dont `file_hash_mismatch_is_reported` qui vérifie en plus
  qu'**aucun fichier de sortie n'est laissé** quand l'empreinte attendue est fausse.
- **Lint / typage** — `npx tsc --noEmit` propre (mobile et API) ; `npx eslint` et
  `npx expo lint` ne signalent **rien** sur les fichiers M3 (les avertissements
  restants sont antérieurs : `ChatComposer`, `swipeable-row`, `EmojiPanel`,
  `emojiCatalog`, `ice`, `calls/engine/PeerStats`) ; `npx oxlint --type-aware`
  sur l'API : 0 erreur.

## 8. Défauts trouvés et corrigés pendant ce lot

| Réf. | Gravité | Défaut | Correction |
|---|---|---|---|
| M3-D1 | Moyenne | Le chargement automatique des vignettes testait une classe réseau **codée en dur à `'wifi'`** : le réglage « données mobiles » n'était jamais consulté, et la règle « jamais hors ligne » n'était pas appliquée. | `mediaPolicy.ts` : fonction pure `classifyNetwork(state)` ; nouveau `useNetworkClass()` (abonnement `expo-network`, libéré au démontage) ; `SecureMediaMessage` consomme la vraie classe. Trois cas de test ajoutés (y compris `ETHERNET`/`VPN`/`UNKNOWN` → non facturé). |
| M3-D2 | Haute | **Le clair ne disparaissait pas à la fermeture du média.** Pour une image ou une vidéo, le fichier déchiffré n'était libéré qu'au **démontage** de l'écran de conversation (bouton « Fermer le média » masqué derrière la modale plein écran). Pour un document, la visionneuse est une **route distincte** : revenir sur la conversation ne démontait pas l'écran E2EE, donc `sweepSecureMedia()` n'était pas rappelé et le clair restait sur le disque indéfiniment après la lecture. Le scénario 2 de preuve (grep après fermeture → aucune sortie) **échouait**. | `e2ee-chat/[id].tsx` : la visionneuse plein écran retient l'`uploadId` et `closeViewer()` appelle `closeMedia(id)` **avant** de fermer la modale ; un `useFocusEffect` libère le clair du document à chaque retour de la route visionneuse (`openedDocumentRef`). |

## 9. État de la preuve sur appareil

- **Scénario 4 (fichiers du téléphone)** : instruction élargie en **scénarios 1 à 4**
  du présent document (contrôle positif pendant la lecture, absence après
  fermeture, absence après redémarrage, absence à l'état normal). **NON VÉRIFIÉ
  ici** : Waydroid refuse `run-as` ; commandes à jouer sur la machine hôte avec
  `waydroid shell`.
- **Rendu réel des vignettes chiffrées** et **visionneuses** (image/vidéo/document) :
  à confirmer au test appareil.
- **Politique de rétention** : 30 jours codés en dur dans
  `UploadRetentionService` — valeur proposée, **à confirmer** par la décision produit.

## 10. Écart assumé par rapport au plan : `FLAG_SECURE` sur les visionneuses

Le plan (§E) demandait `useSecureScreen(true)` sur les visionneuses
(`MediaViewers.tsx`, `document-viewer.tsx`). **Non appliqué**, et voici pourquoi.

`ScreenSecurity.setSecure` pose le drapeau sur **la fenêtre de l'activité** (app
mono-activité, cf. `ScreenSecurityModule.kt`), et `applySecureScreen` retire le
drapeau à son **démontage**. Or :

- la visionneuse image/vidéo est une `Modal` **à l'intérieur** de l'écran
  `e2ee-chat`, qui reste monté : le drapeau posé par l'écran couvre déjà la modale ;
- `document-viewer` est une **route empilée** : l'écran `e2ee-chat` reste monté
  dessous (native-stack conserve les écrans précédents), donc le drapeau y est
  toujours actif.

Ajouter un second `useSecureScreen` sur ces vues créerait un **défaut** : au
retour de la visionneuse, son nettoyage appellerait `setSecure(false)` alors que
l'écran de conversation, toujours monté, est censé garder le drapeau — l'aperçu
« applications récentes » réafficherait le contenu déchiffré. L'effet du réglage
est donc déjà obtenu sans code supplémentaire, et le scénario de vérification
reste : capture d'écran et vignette « récentes » neutres pendant la lecture.

## 11. Verdict

**M3 : prêt pour revue, feu vert M4 non donné.** Les six conditions du lot sont
tenues par code et par test automatisé (mobile 94/94, API M3 7/7, API M2
non-régression 8/8, Rust 12+6, lint et typage propres) :

1. Le serveur ne voit que du ciphertext (`application/octet-stream`, ni type ni
   aperçu) ; la clé et l'empreinte voyagent dans l'enveloppe Olm `v:2`.
2. Toutes les métadonnées photo (EXIF/GPS) sont retirées et la taille réduite
   avant chiffrement ; plafond par type vérifié avant tout chiffrement.
3. Les clairs ne vivent que dans un dossier privé hors cache, balayé à la
   fermeture du média, au démarrage, à la déconnexion et à la perte d'identité.
4. Vignette d'abord, fichier complet sur toucher, selon les réglages réseau.
5. Aucun texte ne promet « aucun clair sur le téléphone » ; aucun libellé
   « chiffré de bout en bout » **ajouté** par M3.
6. Drapeau désactivé par défaut, des deux côtés.

Réserve, comme en M2 : la **preuve sur appareil** (scénarios 1 à 4, §1–4 — le
`grep` du canari) n'a pas pu être exécutée ici, Waydroid refusant `run-as`. Elle
doit être rejouée sur la machine hôte avant tout feu vert. Les deux défauts
trouvés pendant cet audit (dont **M3-D2**, qui faisait échouer le scénario 2)
sont corrigés mais n'ont été éprouvés que par tests automatisés sur cette
branche. **M4 (groupes) ne démarre pas sans le feu vert explicite.**


