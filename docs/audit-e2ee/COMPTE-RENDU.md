# Contre-audit E2EE — lots M1 et M2

Branche : `audit-e2ee-m1-m2` (9 commits de correction, aucun en attente de push).
Méthode : relecture intégrale des diffs `9fa9f50` (M1) et `4a2b351` (M2), puis tests
pilotés dans l'app réelle sur Waydroid x86_64 (drapeaux serveur et mobile activés,
build dev du 2026-11-01 05:40 contenant `libmbolo_crypto.so` et SQLCipher).

Second participant : **client de test scripté** (`api/scripts/e2ee-peer.mjs`)
réutilisant le binaire Rust `crypto/target/release/peer` — même vodozemac, mêmes
endpoints REST/socket que l'app. Choix motivé : Waydroid est mono-instance et le
téléphone Galaxy n'est pas pilotable depuis cet environnement ; le client scripté
exerce le vrai noyau crypto et le vrai protocole, sans dépendre d'un second écran.

## 1. Tableau des scénarios

| # | Scénario | Statut | Preuve |
|---|---|---|---|
| 1 | Connexion A : appareil enregistré, clés publiées et vérifiées | VÉRIFIÉ DANS L'APP | Ligne `e2ee_devices` de `kim.bruneel` créée à 06:51:59 au chargement du bundle ; spike « SQLCipher 4.17.0 · en-tête chiffré · clés chargées » ; vérification de signature exercée à chaque ouverture de session (sc. 2) |
| 2 | Texte A→B, réception chez B, réponse visible chez A | VÉRIFIÉ DANS L'APP | `docs/audit-e2ee/sc2-chat.png` (message du pair déchiffré), `sc2-sent3.png` (réponse de l'app), stdout pair : `Confirmation_pair_attendue` |
| 3 | Preuve serveur : texte absent de la base, des journaux API et du logcat | VÉRIFIÉ DANS L'APP | `select count(*) … ilike` → 0 sur `content` et `payload` ; `grep` journaux API → 0 ; `grep` logcat → 0 ; 3 lignes v1 (267/127/127 octets base64) |
| 4 | Preuve téléphone : aucun clair dans les fichiers de l'app | NON VÉRIFIÉ | Waydroid refuse `run-as` (`setegid` non permis) et `adb root` ; il faut `waydroid shell` sur la machine hôte (commandes en §4) |
| 5 | Kill forcé puis réouverture : historique relu, recherche locale trouve | VÉRIFIÉ DANS L'APP | `sc5-search2.png` : résultat « Confirmation_pair_attendue » ; 3 messages relus depuis SQLCipher. **A révélé D8** (recherche cassée) |
| 6 | Hors connexion puis retour : envoi correct, rien en clair dans la file | VÉRIFIÉ DANS L'APP | `sc6-offline2.png` : erreur claire, brouillon conservé, aucun message fantôme ; après retour : `history` pair → `c3774e68: Test_hors_ligne_6`. L'écran E2EE n'utilise pas la file AsyncStorage (brouillon en base chiffrée) |
| 7 | Messages en désordre et en double | VÉRIFIÉ DANS L'APP | `sc7-burst.png` : rafale-1..3 tous affichés (correction D3), « doublon » une seule fois, session intacte (`Apres_rafale_ok` déchiffré par le pair) |
| 8 | Réinstallation : nouvelle identité, message clair, envoi bloqué jusqu'à confirmation | VÉRIFIÉ DANS L'APP | `sc8-alert.png` : « Ce contact a changé d'appareil » ; après confirmation, pair déchiffre `bb1f98b6: Apres_changement_cle` ; les messages pré-rotation sont indéchiffrables avec la nouvelle identité |
| 9 | Blob Keystore illisible (simulation dev) | VÉRIFIÉ DANS L'APP | `sc9-simulated.png` « Perte simulée OUI », puis « Appareil enregistré » et identité republiée en base (`+QwUvCe0Nt`). **A révélé D9 et D10** |
| 10 | Épuisement des prekeys, conversation utilisable | VÉRIFIÉ DANS L'APP | 9 OTK consommés → 0 ; envoi via fallback déchiffré (`Via_cle_de_secours_10`) ; réserve regarnie à 5 au bootstrap suivant |
| 11 | Notifications génériques | VÉRIFIÉ PAR TEST AUTOMATISÉ | `api/test/push-e2ee.spec.ts` : « ne révèle ni expéditeur ni contenu pour une enveloppe chiffrée ». Non vérifié en app : Waydroid n'a pas de Play Services/FCM |
| 12 | Anti-rétrogradation : clair refusé ; drapeau coupé = comportement inchangé | VÉRIFIÉ DANS L'APP + AUTOMATISÉ | Acquittement serveur : « Les messages en clair sont refusés dans cette conversation », 0 ligne en base ; drapeau coupé : e2e « conserve le comportement historique quand le drapeau est coupé » et « refuse les endpoints quand le drapeau est désactivé » |
| 13 | Non-régression dans l'app | PARTIELLEMENT VÉRIFIÉ DANS L'APP | Groupes : message clair accepté et affiché (`Groupe_toujours_clair_13`, `encryption=none`) — preuve D1 en app ; réglages Confidentialité/Notifications présents. Appels audio/vidéo et notes vocales : **non vérifiés** (exigent un second appareil réel avec micro/WebRTC) |

## 2. Défauts trouvés et corrigés

| Réf. | Gravité | Défaut | Correction |
|---|---|---|---|
| D1 | Haute | Les groupes basculaient en E2EE alors que M2 ne chiffre que le 1:1 → groupe routé vers l'écran 1:1, média et clair refusés, inutilisable | `e2ee.service.ts` : filtre `type='DIRECT'` ; test e2e « ne bascule jamais un groupe » (b8afc60) |
| D2 | Haute | Notification/profil/recherche ouvraient `/chat/[id]` sur une conversation chiffrée → brouillons et file en AsyncStorage hors SQLCipher | Garde unique dans l'écran clair → redirection `/e2ee-chat` (c3d4d7b) |
| D3 | Haute | Course au déchiffrement : deux messages reçus simultanément partaient du même pickle → perte silencieuse | File de déchiffrement sérialisée (ae02a9a) ; preuve sc. 7 |
| D4 | Haute | Première réponse d'un pair ayant changé d'identité jetée sans récupération | Repli prekey → nouvelle session entrante + alerte (ae02a9a) ; test unitaire |
| D5 | Moyen | Session avancée avant écriture du message ; historique re-déchiffrant des messages stockés | Ordre message-avant-session, saut des id/client_id connus, ligne provisoire renommée après ack (ae02a9a) |
| D6 | Moyen | Conversation directe créée après l'enregistrement des deux appareils restait en clair | Bascule à la création ; test e2e + preuve en app (b8afc60) |
| D7 | Faible | Client de test `peer` sans persistance de session (impossible de continuer une conversation) | `peer.rs` : session persistée, réception prekey et normale (2b16584) |
| D8 | Moyen | Recherche locale : `ESCAPE '\'` effondré en `ESCAPE ''` par le gabarit JS → toute recherche levait | Clause corrigée, backslash échappé, test unitaire ; revérifiée en app (445ed1b) |
| D9 | Haute | Après perte de clés, suppression de récupération avalée sans retry → base indéchiffrable permanente | Sonde de lecture dans la boucle, reessai avec suppression effective, erreur remontée sinon (38448f0) |
| D10 | Haute | `status` ne compare que le deviceId : après perte de clés, la nouvelle identité locale n'était jamais republiée → annuaire serveur obsolète, vérifications de prekeys cassées chez le pair | Enregistrement forcé quand le compte est recréé ; preuve sc. 9 (f70dd48) |

## 3. Constats documentés, non corrigés (hors périmètre de correction)

- La clé SQLCipher transite par JavaScript le temps du `PRAGMA key` — risque accepté v1, commenté dans `db.ts`.
- Pas de `FLAG_SECURE` : la vignette « applications récentes » peut exposer un texte déchiffré. Décision produit à prendre.
- Les `plaintext` Rust (`Vec<u8>`) et les clés Java (String) ne sont pas zeroïsables à la frontière JNI ; seule la clé de pickle côté Rust l'est (`Zeroizing`).
- Les fonctions crypto *raw* (clé en paramètre JS) restent exposées pour l'écran spike, gated dev ; le chemin de production n'utilise que les variantes `secure*`.
- Pièces jointes et vocaux refusés en 1:1 chiffré (portée M2 = texte) ; pas de file d'envoi hors-ligne pour E2EE (le brouillon chiffré tient ce rôle).

## 4. Ce qui reste non vérifié et pourquoi

- **Scénario 4 (fichiers du téléphone)** : Waydroid bloque `run-as` et `adb root`. À rejouer sur la machine hôte avec `waydroid shell` (invite `#` ; si l'invite est `$`, préfixer par `su`). Commandes ci-dessous volontairement sans redirection ni tube, pour être tapées telles quelles. Le paquet est `com.groupenzogho.mbolochat`.

  1. Localiser les fichiers de l'app (expo-sqlite range la base E2EE dans `files/SQLite/`, pas dans `databases/`) :
     - `ls -la /data/data/com.groupenzogho.mbolochat/files/SQLite/`
     - `ls -la /data/data/com.groupenzogho.mbolochat/databases/`
     - repli si la base n'est pas là : `find /data/data/com.groupenzogho.mbolochat -name mbolo-e2ee.db`
  2. Prouver que la base E2EE est chiffrée — l'en-tête ne doit **pas** être le texte `SQLite format 3` :
     - `od -An -tx1 -N16 /data/data/com.groupenzogho.mbolochat/files/SQLite/mbolo-e2ee.db`
     - **succès** : 16 octets quelconques, non reconnaissables (pas la chaîne ASCII `SQLite format 3`).
     - **défaut** : l'en-tête affiche `SQLite format 3` → la base est en clair.
  3. Témoin : vérifier que la recherche fonctionne bien sur une base **non** chiffrée (doit trouver au moins une occurrence) :
     - `grep -a -c -e mbolochat /data/data/com.groupenzogho.mbolochat/databases/mbolochat.db`
     - **succès** : un nombre ≥ 1 (la sonde lit réellement le fichier).
     - **défaut** : `0` → la sonde est aveugle, les résultats suivants ne prouvent rien.
  4. Aucun clair dans l'ensemble des fichiers de l'app (le corps déchiffré ne doit vivre que dans la base chiffrée) :
     - `grep -r -a -l -e Confirmation_pair_attendue /data/data/com.groupenzogho.mbolochat/`
     - `grep -r -a -l -e Confirmation_pair_attendue /sdcard/Android/data/com.groupenzogho.mbolochat/`
     - **succès** : aucune ligne affichée.
     - **défaut** : un chemin apparaît (par ex. `files/SQLite/mbolo-e2ee.db` ou `databases/RKStorage`) → texte en clair sur disque.
  5. La base non chiffrée et le stockage AsyncStorage ne contiennent pas le message (`0` attendu) :
     - `grep -a -c -e Confirmation_pair_attendue /data/data/com.groupenzogho.mbolochat/databases/mbolochat.db`
     - `grep -a -c -e Confirmation_pair_attendue /data/data/com.groupenzogho.mbolochat/databases/RKStorage`
     - **succès** : `0` (ou fichier absent pour `RKStorage`).
     - **défaut** : un nombre ≥ 1.

  Remplacer `Confirmation_pair_attendue` par un texte réellement envoyé dans la conversation chiffrée et connu de ce seul message.
- **Scénario 11 en app** (livraison réelle FCM) et **scénario 13 appels/voix** : nécessitent un téléphone ARM64 avec Play Services et un second appareil.
- **Build de release ARM64 avec le drapeau activé** : non testé (les bibliothèques précompilées datent de M2 ; un rebuild EAS est requis avant toute activation).

## 5. Verdict

**M1 : prêt** — les dix décisions d'architecture sont confirmées par code et par test, à l'exception du seul point jamais auditable ici (inspection des fichiers sur l'appareil, §4).

**M2 : pas encore prêt pour le feu vert**, non sur le protocole (les six conditions du feu vert sont tenues après corrections, vérifiées en app), mais parce que : (a) dix défauts dont cinq de gravité haute ont été trouvés pendant cet audit — les correctifs datent de ce jour et n'ont été rejoués que sur Waydroid x86_64 en build dev ; (b) les scénarios 4, 11-livraison et 13-appels restent non vérifiés et exigent un téléphone ARM64 avec Play Services ; (c) la branche `audit-e2ee-m1-m2` n'est pas fusionnée. Le drapeau doit rester désactivé en production jusqu'au rejeu sur téléphone réel.
