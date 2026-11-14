# E2EE — Lot 2 : confiance, éphémères et modification

Ce document fige les contrats du Lot 2. Il ne modifie ni le ratchet Olm, ni les
sessions, ni la gestion ou la publication des clés, ni les formats de médias.
Les nouveaux contenus sont des événements applicatifs à l'intérieur de
l'enveloppe chiffrée existante ; le serveur ne voit que l'enveloppe et les
métadonnées historiques du message.

## Règles communes

- JSON strict : clés exactes, types exacts, chaînes bornées, entiers sûrs. Un
  champ absent, supplémentaire ou mal typé rend le contenu invalide.
- Un contenu invalide, d'une version future ou d'un `kind` inconnu est persisté
  comme ligne masquée (`hidden = 1`, `content_kind = 'unknown'`) : aucune bulle,
  aucun bruit, aucune perte de l'avancement Olm. Les plafonds de brut du Lot 1
  restent applicables.
- Les droits sont vérifiés côté récepteur à partir de l'identité de l'auteur de
  l'enveloppe et des données locales. Un champ déclaratif du payload n'accorde
  jamais de droit.
- Aucun clair, aucune clé et aucun identifiant sensible n'est journalisé.
- Les événements de contrôle sont des lignes locales masquées. Ils ne sont ni
  affichés ni agrégés comme des messages ordinaires.

## Vérification d'identité (aucun nouveau type de contenu)

Le code de sécurité est calculé hors enveloppe, à partir des clés publiques
d'identité Olm des deux interlocuteurs :

- entrée canonique : étiquette de domaine fixe `MboloChat safety number v1`,
  puis les deux clés encodées en base64, triées par ordre lexicographique
  d'octets et préfixées chacune par leur longueur ;
- SHA-256 de cette entrée ; la valeur lue comme entier est ramenée modulo
  `10^60` et complétée à gauche par des zéros ;
- affichage en 12 groupes de 5 chiffres ; QR `mbolo-identity-v1:<60 chiffres>`.

Le résultat est indépendant de l'ordre des interlocuteurs. L'état vérifié est
local à l'appareil et lié à l'empreinte de la clé d'identité du pair. Un
changement de clé d'identité remet l'état à « non vérifié », conserve un
marqueur `key_changed_at` et affiche le bandeau « code de sécurité modifié ».
Le scan compare le contenu QR normalisé au code affiché ; aucune clé ne transite
par le QR au-delà de ce que le scan local permet de comparer.

## `v:6` — réglage éphémère de conversation

```json
{"v":6,"kind":"ephemeral","ttlSeconds":0,"version":1760000000000}
```

- `ttlSeconds` : jeu fermé `0`, `86400` ou `604800`. `0` désactive.
- `version` : entier positif sûr, strictement croissant ; l'émetteur utilise
  `max(version_locale + 1, Date.now())`. La version la plus grande gagne ; une
  version égale ou inférieure est ignorée (pas de ping-pong).
- Le réglage est écrit localement dans `e2ee_conversation_state`. Il ne
  s'applique qu'aux **nouveaux** messages : `expires_at = createdAt + ttl`.
- Les messages déjà émis conservent leur échéance. Une désactivation n'efface
  pas les échéances existantes.
- À l'échéance, le texte, les références média, le ciphertext local, la vignette
  et le payload inconnu sont effacés ; la ligne reste comme mention supprimée.
  La purge tourne au démarrage et périodiquement pendant que l'application est
  ouverte, avec le même nettoyage de fichiers que la suppression pour tous.
- Le bandeau d'en-tête affiche la durée active et rappelle que le correspondant
  peut conserver une copie.
- Métadonnée serveur : l'échéance n'est pas transmise ; le serveur peut déduire
  l'existence d'un événement de contrôle par la taille et l'horodatage de
  l'enveloppe, jamais sa valeur.

## `v:7` — modification d'un message texte

```json
{"v":7,"kind":"edit","targetId":"<id>","revision":1,"text":"nouveau texte"}
```

- `targetId` : identifiant local serveur, motif `[A-Za-z0-9_-]{1,128}`.
- `revision` : entier `1..5`, strictement croissant pour une cible.
- `text` : 1 à 4000 unités UTF-16, texte seulement. Pas de média, sticker,
  citation ni nouvelle cible.
- Droits : seul l'auteur du message cible peut le modifier. Le récepteur vérifie
  l'auteur de l'enveloppe, `mine`/`sender_id`, l'absence de suppression et la
  fenêtre de 15 minutes calculée sur les horodatages serveur (`created_at` de la
  cible et de l'événement).
- Une révision supérieure remplace le texte, sans conserver l'ancien. Une
  révision inférieure ou égale est ignorée. Une modification reçue avant son
  message d'origine est **ignorée** (pas de file d'attente) : la ligne de
  contrôle reste masquée pour l'idempotence. Une modification sur un message
  supprimé ou d'un autre auteur n'est jamais appliquée.
- L'interface affiche « modifié » sans exposer l'ancien texte.

## Stockage et rétro-compatibilité

- `v9` : `e2ee_identity_verifications(peer_user_id, peer_identity_key,
  fingerprint, verified_at, key_changed_at, updated_at)`.
- `v10` : `e2ee_conversation_state(conversation_id, ephemeral_ttl_seconds,
  ephemeral_version, updated_at)` et colonne `e2ee_messages.expires_at`.
- `v11` : colonnes `e2ee_messages.edited_at` et `edit_revision`.
- Toutes les migrations sont additives et n'écrivent aucun clair hors SQLCipher.
- Un ancien client traite `v:6` et `v:7` comme des contenus inconnus masqués :
  il n'affiche rien et continue à déchiffrer les messages suivants. Les `v:1` à
  `v:5` restent strictement inchangés.
- Aucun ancien écran n'est supprimé dans ce lot ; B.3.6 reste hors périmètre.
