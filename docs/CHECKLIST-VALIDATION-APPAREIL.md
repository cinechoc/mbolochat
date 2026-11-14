# Checklist de validation sur appareil — fusion des conversations (Phase 5)

Version 1.0 — 2026-11-13. À passer sur **Waydroid** (ou appareil réel) après chaque pas visible de la Phase 5, et obligatoirement avant B.3.6 (retrait des anciens écrans).

## Prérequis

- API et PostgreSQL démarrés, Metro `--dev-client` lancé, application installée dans Waydroid.
- **Deux comptes** de test : A et B. Une conversation directe claire, une conversation directe chiffrée (`E2EE_ENABLED=true` côté API et client), un groupe de 3 comptes.
- Pour les scénarios hors ligne : couper le réseau du conteneur (`adb shell svc wifi disable` / `svc data disable`) ou arrêter l'API, jamais les deux à la fois.
- Noter pour chaque ligne : **OK**, **KO** (avec capture), ou **N/A**.

## Matrice (une ligne par fonctionnalité du plan §10.1)

| # | Fonctionnalité | Mode clair — scénario | Mode chiffré — scénario | Attendu |
|---|---|---|---|---|
| 1 | Envoi texte | A écrit « test clair », envoie ; couper le réseau, écrire un 2e message, rétablir | A écrit « test chiffré », envoie ; couper le réseau, écrire un 2e message, rétablir | Bulle immédiate, coche horloge puis envoyée ; reprise sans doublon |
| 2 | Réception | B envoie pendant que A est sur l'écran ; puis A en arrière-plan, B envoie | Idem en chiffré | Message affiché une seule fois, ordre chronologique, pas de doublon au retour |
| 3 | Pagination | Remonter au-delà de 30 messages (jeu de 200 messages via `perf-seed`) | Remonter dans l'historique local (> 50 messages) | Chargement sans doublon ni saut ; en chiffré, comportement actuel conservé |
| 4 | Notes vocales | A enregistre 5 s, envoie ; B écoute | A enregistre 5 s, envoie ; B écoute | Lecture, waveform, durée, accusé ; en chiffré, clair libéré à la fermeture |
| 5 | Images et vidéos | A envoie 3 photos (album), une vidéo, un PDF ; B ouvre chaque média | Idem en chiffré | Vignettes, visionneuse, document ; en chiffré, aucune fuite de clair (fichier temporaire supprimé) |
| 6 | Réponses | Appui long → Répondre → envoyer ; taper la citation | Idem en chiffré | Citation correcte, saut vers l'original ; supprimé = « Message supprimé » |
| 7 | Réactions | Appui long → réaction panthère ; B réagit au même message | N/A (non supporté) | Compteur et état « mine » corrects ; en chiffré, section absente |
| 8 | Suppression | A supprime pour moi, puis pour tous un message envoyé | A supprime pour moi un message | Clair : disparition locale / « Message supprimé » chez B. Chiffré : disparition locale, aucune option « pour tous » |
| 9 | Accusés de lecture | A envoie, B ouvre la conversation ; groupe : « Vu par N » | A envoie, B est en ligne / hors ligne / ouvre l'écran | Clair : simple/double coche puis bleue, Vu par. Chiffré : « Reçu » si B en ligne, « Ouvert » seulement si la bulle est réellement visible (50 %, 400 ms) |
| 10 | Indicateur de frappe | A tape dans une conversation claire, B regarde | N/A | « B est en train d'écrire… » puis disparition ; absent en chiffré |
| 11 | Brouillon | A tape sans envoyer, quitte, revient | A tape sans envoyer, quitte, revient | Clair : texte restauré. Chiffré : texte restauré depuis SQLCipher ; vérifier qu'aucun brouillon clair n'existe (fichier AsyncStorage) |
| 12 | Défilement | Remonter, recevoir un message : pastille de retour, compteur | Remonter, recevoir un message ; **vérifier la nouvelle liste inversée** | Pas de saut, pastille et compteur corrects ; en chiffré, pas de retour forcé en bas |
| 13 | État de connexion | Couper le réseau : bandeau hors ligne ; rétablir | Couper le réseau, revenir | Bandeau clair ; en chiffré, aucun envoi optimiste, accusés en attente |
| 14 | Menus | Appui long sur texte, photo, vocal, sticker | Appui long sur texte, média, sticker | Actions filtrées par mode ; « Retirer pour tous » absent en chiffré ; transfert texte chiffré → cible chiffrée uniquement |
| 15 | Accessibilité | TalkBack : parcourir liste, coches, boutons d'envoi, erreurs | TalkBack : parcourir, en-tête, appels inertes, erreurs | Tout est annoncé, ordre logique, aucune action sans libellé |
| 16 | Groupes, rôles, mentions | Groupe : rôle admin/membre, `whoCanSend=admins`, mention `@` | N/A (1:1 uniquement) | Permissions respectées, mentions proposées, aucun groupe chiffré |
| 17 | Appels | Appel vocal/vidéo 1:1, puis groupe | Icônes d'appel | Clair : appel abouti. Chiffré : alerte explicite, aucun appel lancé |
| 18 | Sécurité d'écran | N/A | Afficher la conversation chiffrée dans le sélecteur d'applications ; capture d'écran | Aperçu neutre (FLAG_SECURE), aucun média chiffré en clair après fermeture |

## Vérifications spécifiques à la fusion

- **Mode inconnu / hors ligne** : ouvrir une conversation jamais mise en cache, réseau coupé → état d'attente **sans compositeur**, jamais l'écran clair. Rétablir le réseau → l'écran se résout seul.
- **Cache chiffré hors ligne** : ouvrir hors ligne une conversation chiffrée déjà vue → mode chiffré, messages locaux lisibles.
- **Anti-downgrade** : tenter d'ouvrir une conversation chiffrée depuis un lien/notification → jamais de compositeur clair.
- **Bascule par drapeau (B.3.5)** : drapeau désactivé → ancien écran ; activé → écran unifié. Comparer chaque ligne ci-dessus entre les deux.
- **Liste inversée chiffrée** : le passage à la liste inversée ne doit pas déclencher « Ouvert » pour un message qui traverse l'écran ; vérifier avec un long historique.

## Résultat

Consigner la date, la build/commit, l'appareil, et joindre les captures des KO. La Phase 5 ne peut être déclarée terminée qu'avec toutes les lignes OK ou N/A justifiées.

## Traçabilité — nouveau chemin de code (B.3.5b)

| # | Fonctionnalité | Fichier / fonction du nouveau chemin | État |
|---|---|---|---|
| 1 | Envoi texte | `features/chat/ui/chat-screen.tsx` → `sendText` → `transport.sendText` (`classic-transport.ts` / `e2ee-transport.ts`) | Complet |
| 2 | Réception | `hooks/use-chat-messages.ts` → `messagesReducer` ; transports `subscribe` | Complet |
| 3 | Pagination | `classic-transport.ts` `loadOlder` ; chiffré : `loadOlder` vide | **Manque en chiffré (assumé)** |
| 4 | Notes vocales | `chat-message-row.tsx` `VoiceMessageBubble` ; `e2ee-transport.ts` `sendVoice` | Complet |
| 5 | Images/vidéos/documents | `chat-message-row.tsx` `MessageBody` ; `chat-screen.tsx` `openMedia` + `model/media-leases.ts` | Complet |
| 6 | Réponses | `chat-screen.tsx` `quoteOfView` ; `chat-message-row.tsx` `QuoteBlock` | Complet |
| 7 | Réactions | `model/chat-actions.ts` + `chat-message-row.tsx` `ReactionChips` ; capacité `reactions` | Clair uniquement |
| 8 | Suppression | `chat-screen.tsx` `menuActions` → `transport.deleteMessage` | Complet |
| 9 | Accusés | `chat-message-row.tsx` `ReceiptBadge` ; `e2ee-transport.ts` `deliveryOf` | Complet |
| 10 | Frappe | `chat-screen.tsx` bandeau + `use-chat-messages.ts` `typing` | Clair seulement |
| 11 | Brouillon | `use-chat-draft.ts` + `model/draft-buffer.ts` ; transport `saveDraft/loadDraft` | Complet |
| 12 | Défilement | `use-chat-scroll.ts` + `model/scroll-state.ts` ; liste inversée les deux modes | Complet, **à vérifier appareil** |
| 13 | Connexion | `use-chat-messages.ts` `online` + bandeau `chat-screen.tsx` | Complet |
| 14 | Menus | `model/chat-actions.ts` ; transfert `e2ee-transport.ts` `forwardText` ; favori `chat-screen.tsx` | Complet, y compris favori sticker classique |
| 15 | Accessibilité | `docs/ACCESSIBILITE-FUSION-CHAT.md` | Complet, pertes listées |
| 16 | Groupes | `chat-screen.tsx` (permissions, mentions) | Complet |
| 17 | Appels | `chat-screen.tsx` `headerRight` ; refus chiffré | Complet |
| 18 | Sécurité d'écran | `hooks/use-chat-security.ts` + `model/media-leases.ts` | Complet |

Scénarios marqués manquants : pagination chiffrée (#3), indicateur de frappe chiffré (#10, volontairement absent).

## Résultats Waydroid — 2026-11-14

Statuts utilisés : **OK**, **KO corrigé**, **KO ouvert**, **non vérifié**.

- Branche : `refactor/phase-5-unification-chat`, code `1f67b73` sur `1987a15` et `95b597b` ; aucun push, B.3.6 non commencé.
- Appareil : Waydroid `192.168.240.112:5555`, paquet `com.groupenzogho.mbolochat`, API `:3001` et Metro `:8081` actifs.
- Drapeau unifié : **ON** pendant les comparaisons de la session B.3.5b, puis remis à **OFF**. Depuis la clôture B.3.5c, il est **activé par défaut** ; `/dev-flags` permet encore de revenir à l'ancien écran.
- Conversations : clair direct `b91f5c98-0d7f-4b7e-8041-e9338a9596b6` (« Test Demo »), groupe `50e68ebf-967a-4ced-8e69-44525329ca04` (« On boit où? »), chiffré direct `d84d01ea-0c70-49d6-aa3f-f72777f13bfc`.
- Second compte clair : `alice.martin` / `password123` (client socket secondaire pour les réceptions).

### Mode clair, drapeau unifié activé

| Scénario | Statut | Résultat observé |
|---|---|---|
| Conversation historique directe | OK | Historique, envoi, réception, réponse, réaction et suppression « pour tous » validés sur l'ancien écran. Les mêmes parcours sont OK sur l'écran unifié ; pour la suppression, la parité du menu est vérifiée mais l'action n'y a pas été rejouée. |
| Groupes | OK | Affichage de « On boit où? », réception d'`alice.martin`, réponse et réaction. Envoi `UNIFIED_GROUP_20261114_0627` affiché une seule fois, état « Envoyé ». |
| Envoi / réception / réponses / réactions | OK | Réception réelle `PEER_UNIFIED_20261114_0629` via socket secondaire, réponse `UNIFIED_REPLY_20261114_0631` avec citation correcte, réaction « Pouce levé » à 1. |
| Suppression | OK | Suppression pour moi et « Retirer pour tous » exécutées sur l'ancien écran. Parité du menu vérifiée sur l'écran unifié : ancien et nouveau affichent les mêmes actions pour un message personnel. |
| Notes vocales claires | OK | Enregistrement par appui maintenu, note `0:03`, envoi puis lecture réelle par ExoPlayer. |
| Documents clairs | OK | PDF poussé dans `/sdcard/Download`, envoyé, affiché (`PDF · 1 Ko`) et ouvert page 1/1. |
| Pagination longue claire | OK avec réserve | Conversation de 140 messages, remontée sur plusieurs écrans jusqu'au 28 octobre et avant, aucun doublon visible. Ralentissement puis `uiautomator` bloqué sur « idle state » ; application toujours active, aucun crash. |
| Appels clairs | non vérifié sur appareil, reporté | Le câblage bouton → écran d'appel avait été observé, mais l'appel réel n'est pas validé. Waydroid ne fournit pas de caméra fonctionnelle. |

### Écran unifié — KO et parité

| Point | Statut | Détail |
|---|---|---|
| Doublon d'un envoi clair | KO corrigé | Doublon transitoire observé pour `UNIFIED_CLEAR_20261114_0625` (`clientId mwg0sxvv-6-4yd9dkn2`, message serveur `4af06a69-4b47-4ba7-9df7-afb51e11283f`), absent de l'ancien écran. Correctif `1f67b73` : l'upsert unifié remplace désormais une bulle optimiste par le message serveur de même `clientId` et retire tout doublon résiduel. Revérifié sur appareil avec `UNIFIED_DEDUP_FIX_20261114_0745` : une seule bulle. |
| « Retirer pour tous » dans le groupe | OK | Fausse alerte : le menu du message personnel affiche bien « Supprimer pour moi » et « Retirer pour tous » sur l'écran unifié comme sur l'ancien. |
| Bandeau « Historique en clair » | OK | Présent en direct et en groupe. |
| Contamination entre conversations | OK | Aucune contamination en navigation normale par la liste. Le saut direct par deep link d'une conversation à l'autre reproduit aussi l'affichage croisé sur l'ancien écran : fausse alerte, non imputable à la fusion. |

### Mode chiffré

| Scénario | Statut | Résultat observé |
|---|---|---|
| Note vocale chiffrée | OK | Créée en `v1`, déchiffrée à la demande, affichée puis lue par ExoPlayer. |
| Document chiffré | OK | Envoyé, rouvert après rechargement, PDF affiché page 1/1. |
| Repli sur le cache SQLCipher et bandeau hors ligne | OK | Le mode reste `e2ee` avec le cache ; un résumé inconnu met l'écran en attente. Aucun basculement en clair. |
| Fermeture du clair après lecture | OK dans le code et les tests / non vérifié sur disque | `openedDocumentRef` + `useFocusEffect` appellent `closeMedia` ; `mediaStore.test.ts` couvre le nettoyage. L'inspection directe du dossier privé est impossible sur Waydroid (`run-as` refusé). |
| Envoi hors ligne chiffré | Erreur explicite, pas de file | `E2eeTransport.sendText` appelle uniquement `crypto.sendEncryptedText` et remonte l'échec ; aucun envoi clair, aucune outbox E2EE. Depuis B.3.5c, le compositeur restaure le texte échoué, ou l'ajoute à la saisie reprise entre-temps. `failed-text.test.ts` couvre la logique ; validation visuelle sur appareil restant à refaire. |

### Non vérifié sur appareil

- **« Reçu » / « Ouvert »** : non vérifié sur appareil, reporté faute de deuxième client réel sur un téléphone. Couverture unitaire : `mobile/src/features/e2ee/receipts.test.ts` (états et fusion des accusés) et `mobile/src/features/chat/transport/e2ee-transport.test.ts` (mise à jour d'une bulle à l'arrivée de « Reçu » puis « Ouvert »).
- **TalkBack** : non vérifié sur appareil, reporté. Inventaire et renvois : `docs/ACCESSIBILITE-FUSION-CHAT.md` ; les libellés de coches sont portés par `mobile/src/features/chat/ui/message-receipt.tsx`.
- **Appel clair de bout en bout** : non vérifié sur appareil, reporté ; Waydroid ne fournit pas de caméra fonctionnelle. Seul le câblage bouton → écran d'appel avait été observé.

## B.3.5c — correctifs avant mise en service (2026-11-14)

### Correctifs couverts localement

| Point | Statut | Preuve / limite |
|---|---|---|
| Texte restauré après échec E2EE | OK tests / non vérifié appareil | `ChatComposer` vide après acceptation et restaure sur rejet (`failed-text.test.ts`). L'ancien écran chiffré propage aussi l'échec. En classique, une panne réseau reste dans l'outbox avec bulle en échec et « Réessayer » ; seule une erreur d'enqueue restaure la saisie. |
| Garde centrale des appels clairs | OK tests / non vérifié appareil | `guardDirectCall` refuse `DIRECT + e2eeSince` avant `getMedia()` et le micro ; le mode inconnu échoue fermé. Les appels de groupe ne passent pas par cette garde. |
| Détection 401 des téléchargements | OK tests | `expo-file-system@58.0.13` émet `status: 401` sur Android, `status 401` sur iOS et `HTTP 401` dans la tâche iOS. `downloadError.ts` privilégie `status`/`statusCode`, vérifie `ERR_UNABLE_TO_DOWNLOAD`, puis parse les trois messages. `mediaStore.ts` ne change que l'appel de cette détection. |
| `api.request` après refactor | OK tests | `api.request.test.ts` couvre un refresh puis un seul rejeu, deux 401 sans boucle, et un refresh partagé entre deux requêtes concurrentes. |
| Favori sticker classique / cache après transfert | OK tests | Action de menu portée sur l'écran unifié ; `e2ee-transport.test.ts` vérifie la mise à jour de `patchConversation` pour la cible. |

### Vérifications Waydroid B.3.5c

| Scénario | Statut | Résultat |
|---|---|---|
| « Supprimer pour tous » sur l'écran unifié | non vérifié sur appareil, reporté | Le drapeau a été ouvert, puis Waydroid a déclenché un ANR au rechargement. Le service Android `activity` a ensuite disparu ; `am start` répond `Can't find service: activity` et `force-stop` renvoie `Surface DEAD_OBJECT`. Aucun message de test n'a été supprimé. |
| A/B fluidité, conversation de 140 messages | non vérifié sur appareil, reporté | Aucune mesure `gfxinfo` n'a pu être lancée après la panne du système invité. Aucun chiffre n'est inventé ; les deux passes restent à refaire après redémarrage de Waydroid. |
| État final du drapeau sur l'appareil | non vérifié sur appareil, reporté | Le code est désormais activé par défaut et `/dev-flags` permet le retour. L'état persisté dans Waydroid n'a pas pu être relu après la panne. |
