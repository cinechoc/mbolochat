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
