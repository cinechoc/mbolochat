# E2EE — Lot 1 : parité 1 à 1

Statut : spécification de mise en œuvre. Périmètre limité aux conversations directes.
Le chiffrement Olm, les sessions, les clés, les algorithmes et les formats média
existants ne changent pas. Les nouveaux contenus sont des objets JSON sérialisés
puis chiffrés dans l’enveloppe Olm existante.

## Règles communes

- Le serveur ne reçoit que l’enveloppe chiffrée et les métadonnées historiques du
  message. Aucun contenu applicatif, aucune clé et aucun identifiant local de média
  ne lui sont envoyés en clair.
- Tout payload reçu est validé avant usage : type JSON exact, champs obligatoires,
  chaînes bornées, jeux de valeurs fermés et absence de champs inattendus.
- Un payload invalide est rejeté silencieusement : aucun plantage, aucune bulle et
  aucun journal contenant le contenu. La session Olm avance quand même et une ligne
  locale chiffrée conserve le motif normalisé et le payload brut pour une future
  version du client.
- Un type ou une version inconnus suivent le même chemin : ligne locale masquée,
  aucun bruit dans la conversation, aucune perte de l’avancement Olm.
- Les droits sont vérifiés côté récepteur, à partir des données locales et de
  l’identité de l’auteur de l’enveloppe, jamais d’un champ déclaratif du payload.
- Aucun contenu déchiffré, clé, URI de média ou identifiant sensible n’est écrit
  dans les journaux.

## Encodage binaire

Le contenu utile est le même que pour `v:1` à `v:3` : JSON UTF-8 encodé en base64
par `encodeText`, puis passé à l’enveloppe Olm existante. Les tailles ci-dessous
portent sur les chaînes JSON avant encodage base64.

## `v:4` — réaction

```json
{"v":4,"kind":"reaction","targetId":"<message-id>","reaction":"mbolo-panther-2d/amour","action":"add"}
```

- `targetId` : chaîne de 1 à 128 caractères, `[A-Za-z0-9_-]` uniquement. Cible un
  message visible de la conversation directe déjà confirmé par le serveur.
- `reaction` : liste fermée `mbolo-panther-2d/{amour,fou-rire,pouce-leve,choc,
  tristesse,colere}`.
- `action` : `add` ou `remove` uniquement.
- Champs exactement : `v`, `kind`, `targetId`, `reaction`, `action`.
- Droits : chaque participant peut réagir à un message non supprimé. Le récepteur
  identifie l’auteur de la réaction par le message Olm qui la transporte, jamais par
  un champ du JSON. Une réaction sur une cible inconnue est conservée dans
  SQLCipher et agrégée si la cible arrive ensuite ; elle ne crée aucune bulle.
- Idempotence : clé primaire sur l’identifiant serveur de l’événement ; l’agrégat
  est un ensemble `(cible, réaction, auteur)`. Un ajout répété ne compte pas deux
  fois, un retrait retire l’auteur. L’ordre d’arrivée des événements est respecté ;
  seule la dernière opération connue de chaque auteur fait foi.
- Une réaction ciblant un message supprimé, une réaction ou une suppression est
  ignorée à l’affichage.

## `v:5` — suppression pour tous

```json
{"v":5,"kind":"delete","targetId":"<message-id>"}
```

- `targetId` : mêmes règles que `v:4`.
- Champs exactement : `v`, `kind`, `targetId`.
- Droits : seul l’auteur du message ciblé peut demander sa suppression. Le
  récepteur compare l’auteur du message de suppression à `e2ee_messages.sender_id`
  de la cible. Une suppression d’un autre auteur est ignorée silencieusement.
- Si la cible existe : supprimer le corps, les références média, la vignette,
  la citation et la référence de sticker dans SQLCipher, puis supprimer les
  ciphertexts durables devenus non référencés.
- Si la cible n’existe pas encore : écrire une tombstone
  `(target_id, author_id, event_message_id, created_at)` sous le même verrou. À
  l’arrivée ultérieure de la cible, la tombstone est appliquée dans la transaction
  qui écrit le message.
- La rangée locale reste visible comme « Supprimé pour tous si le correspondant
  est à jour », sans contenu. Le libellé est volontairement non absolu : un pair
  ancien ou hors ligne peut ne pas encore avoir traité l’événement.

## Sticker `v:3`

Le format déjà défini reste inchangé :
`{"v":3,"kind":"sticker","stickerRef":"<pack/id>","replyTo?":"<message-id>"}`.
L’émission passe par le chiffrement existant. Les stickers personnels, qui sont des
fichiers et non des références de catalogue, ne sont pas convertis en `v:3` dans ce
lot.

## Indicateur de frappe

La frappe n’est pas un contenu Olm et n’est jamais stockée. Le client émet
l’événement serveur existant `typing` avec uniquement
`{conversationId, typing:boolean}` ; aucun texte, même partiel, n’est envoyé.
Le client limite les émissions à une par 180 ms et efface l’état reçu après
expiration (4 s) ou sur `typing:false`. Le réglage existant `typingIndicator` est
conservé comme interrupteur.

Métadonnée inévitable côté serveur : il peut déduire qu’un utilisateur participe à
une conversation et qu’il est probablement en train de saisir un message, avec la
fréquence et l’horodatage des événements. Il ne peut pas connaître le texte, la
langue, la longueur ni le contenu du message.

## Stockage SQLCipher

- `e2ee_messages` reste la source de vérité des événements reçus. Les colonnes
  ajoutées sont : `hidden`, `content_kind`, `control_target`, `reaction`,
  `reaction_action`, `raw_payload`. Les lignes de contrôle sont masquées de la
  conversation mais conservées pour l’idempotence et l’avancement Olm.
- Les réactions sont agrégées à la lecture depuis ces lignes de contrôle, filtrées
  par conversation, cible, réaction et auteur.
- Une tombstone tardive vit dans `e2ee_deletions`, table locale chiffrée. Elle ne
  quitte jamais l’appareil.
- Les migrations sont additives, versionnées et ne réécrivent aucune migration
  déjà appliquée. Une base antérieure reste lisible ; les lignes anciennes ont
  `hidden = 0` et `content_kind = NULL`, donc un contenu visible normal.

## Cas limites et rétro-compatibilité

- Cible inconnue : l’événement est stocké masqué ; aucun message factice n’est créé.
- Ordre inversé : la tombstone ou la réaction attend la cible. Une cible qui arrive
  après une suppression est écrite puis immédiatement vidée dans la même transaction.
- Doublon : l’identifiant serveur unique empêche de rejouer l’événement ; l’agrégat
  de réactions reste idempotent même si un pair renvoie plusieurs fois la même action.
- Type inconnu : version future ou `kind` inconnu masqué, payload brut conservé en
  SQLCipher, message suivant déchiffrable car la session a avancé.
- Un client ancien qui ignore `v:4` ou `v:5` ne doit pas casser : il les traite comme
  des contenus illisibles masqués. Les `v:1` à `v:3` restent strictement identiques.
