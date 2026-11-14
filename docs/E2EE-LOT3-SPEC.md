# E2EE — Lot 3 : texte avancé en conversation directe

Ce document fige le contrat du Lot 3. Il ne modifie ni le ratchet Olm, ni les
sessions, ni la gestion ou la publication des clés, ni les algorithmes, ni les
formats de médias existants. Les options décrites ici sont des champs
applicatifs à l'intérieur de l'enveloppe chiffrée `v:8` ; le serveur ne reçoit
ni le texte, ni l'aperçu, ni les options. Les groupes et le transport classique
restent hors périmètre.

## Règles communes

- JSON strict : clés exactes, types exacts, chaînes bornées, URL `http`/`https`
  uniquement. Tout champ absent de façon interdite, supplémentaire ou mal typé
  rend le contenu invalide ; le message est alors persisté comme contenu
  authentifié mais illisible (`unsupported_version` ou `invalid_payload`).
- Un client qui ne connaît pas `v:8` conserve l'avancement Olm et ignore la
  bulle sans bruit. Il ne perd jamais le message suivant.
- Aucun clair, aucune clé et aucun identifiant sensible n'est journalisé.
- Le Markdown (`**gras**`, `*italique*`, `~barré~`, `` `monospace` ``) reste du
  texte brut : il ne crée aucun champ supplémentaire et le rendu local existant
  s'applique tel quel.
- Les brouillons restent dans `e2ee_drafts`, donc dans SQLCipher. Aucun
  brouillon ne passe par le serveur ni par le cache SQLite en clair.

## `v:8` — texte avec options

```json
{
  "v": 8,
  "kind": "text",
  "text": "bonjour https://exemple.test",
  "replyTo": "message-42",
  "silent": true,
  "viewOnce": true,
  "preview": {
    "url": "https://exemple.test/article",
    "host": "exemple.test",
    "title": "Titre de l’article",
    "description": "Description courte",
    "imageUrl": "https://exemple.test/cover.jpg"
  }
}
```

Champs :

- `text` : chaîne de 1 à 4000 unités UTF-16.
- `replyTo` : facultatif, identifiant `[A-Za-z0-9_-]{1,128}`.
- `silent` et `viewOnce` : facultatifs ; s'ils sont présents, leur seule valeur
  admise est `true`. L'absence signifie `false`.
- `preview` : facultatif, objet à clés exactes. `url` et `imageUrl` font au plus
  2048 caractères ; `host` au plus 253 ; `title` au plus 90 ; `description` au
  plus 180. `imageUrl` est facultatif mais, s'il est présent, doit être une URL
  `http`/`https`. Le builder ajoute les champs optionnels uniquement lorsqu'ils
  ont une valeur.
- `scheduledAt` n'est **jamais** transmis : c'est une métadonnée locale de
  l'expéditeur, stockée uniquement dans SQLCipher. Le message est chiffré et
  émis au moment de l'échéance.

Lorsqu'aucune option, aucun aperçu et aucune citation ne sont demandés, le
client continue d'émettre le format historique `v:1` au bit près. `v:8` n'est
utilisé que lorsqu'un champ supplémentaire est réellement présent.

## Droits et comportement

- Tout pair d'une conversation directe peut envoyer un texte `v:8`. `silent` et
  `viewOnce` ne concernent que le message qui les porte.
- `viewOnce` est une protection coopérative : elle masque la bulle, puis efface
  la copie locale et demande l'effacement serveur à l'ouverture. Elle ne peut
  pas empêcher un correspondant de prendre une photo de son écran.
- `silent` est rendu par l'icône « cloche barrée » et l'absence de son dans
  l'interface. Le push E2EE étant générique et chiffré, le serveur ne peut pas
  garantir la suppression du son ou de la vibration d'une notification poussée
  sans apprendre le drapeau. Cette limite est assumée.
- L'aperçu est calculé par l'expéditeur puis chiffré avec le message. Le
  récepteur affiche les métadonnées reçues sans refaire la requête HTML ; le
  chargement de `imageUrl` reste une requête d'image distante. Une URL absente
  ou invalide ne bloque jamais l'envoi : elle est simplement omise.

## Cas limites

- Un aperçu mal formé, trop long, avec une clé supplémentaire ou un schéma
  autre que `http`/`https` est rejeté silencieusement : le message texte reste
  lisible et l'aperçu est ignoré.
- Un `replyTo` invalide rend le payload invalide, comme pour `v:1`.
- Une programmation dans le passé, à moins d'une minute ou au-delà d'un an est
  refusée par la couche de saisie ; une échéance devenue due pendant que
  l'application était fermée est envoyée au prochain démarrage, avec le même
  `clientId` idempotent.
- Une programmation en échec reste dans SQLCipher avec un état local en échec ;
  elle n'est pas réémise en boucle. L'utilisateur peut réessayer ou la jeter.

## Stockage local

Migration `v12` de la base SQLCipher :

- `e2ee_messages.silent INTEGER NOT NULL DEFAULT 0` ;
- `e2ee_messages.view_once INTEGER NOT NULL DEFAULT 0` ;
- `e2ee_messages.preview_json TEXT` ;
- `e2ee_messages.scheduled_at TEXT` ;
- `e2ee_messages.send_error TEXT` ;
- index partiel sur les messages programmés en attente.

Un message programmé est d'abord une ligne locale avec `id = client_id`, son
texte, ses options et son aperçu. À l'échéance, l'enveloppe Olm est créée avec
le même `clientId`, puis la ligne est renommée avec l'identifiant serveur. En
cas de succès ou d'échec, aucune donnée en clair ne quitte SQLCipher.

## Rétro-compatibilité

Les formats `v:1` à `v:7` restent inchangés. Un ancien client traite `v:8` comme
un type inconnu masqué et poursuit normalement la conversation. Une base
antérieure à `v12` conserve ses messages et gagne les nouvelles colonnes avec
leurs valeurs par défaut ; aucun message existant n'est réécrit.
