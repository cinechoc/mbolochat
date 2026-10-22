# MboloChat

Application de messagerie temps réel (MVP) : conversations 1-1 et groupes.

- **Mobile** : React Native + Expo (Android d'abord, iOS plus tard avec le même code)
- **API** : NestJS + Drizzle ORM + PostgreSQL + Socket.IO
- **Temps réel** : WebSocket via Socket.IO (envoi/réception instantanés)

## Structure

```
mbolochat/
├── api/          # Backend NestJS (REST + WebSocket)
│   ├── src/      # auth, users, conversations, chat (gateway), uploads, media, push, db
│   ├── drizzle/  # Migrations SQL générées
│   ├── scripts/  # Smokes : WebSocket, push, fiabilité, sécurité
│   └── test/     # Tests e2e (REST)
├── mobile/       # App Expo (React Native) — nom affiché : MboloChat
│   └── src/
│       ├── app/         # Écrans (expo-router) : login, register, chats, new-chat, chat/[id], settings
│       ├── components/  # Bulles, lecteur/enregistreur vocal, sélecteurs…
│       └── lib/         # API client, auth, socket, file d'envoi hors-ligne, sync, stockage local
└── docker-compose.yml  # PostgreSQL pour le dev
```

## Prérequis

- Node.js 20+
- PostgreSQL (via Docker : `docker compose up -d`, ou une instance locale)
- Pour tester sur Android : un **development build** (`npx expo run:android` ou `eas build --profile development`). Expo Go ne suffit plus : notifications FCM, micro et appareil photo passent par des modules natifs.

## Démarrage

### 1. Base de données

```bash
docker compose up -d
```

### 2. API

```bash
cd api
npm install
cp .env.example .env   # DATABASE_URL, JWT_SECRET, PORT, MEDIA_SECRET, CORS_ORIGINS
npm run start:dev
```

Les migrations SQL s'appliquent automatiquement au démarrage. L'API écoute sur `http://localhost:3001`.

Variables utiles (voir `api/.env.example`) : `PORT`, `CORS_ORIGINS` (origines web autorisées, séparées par des virgules), `MEDIA_SECRET` (clé des URLs de médias signées ; `JWT_SECRET` sert de repli), `NODE_ENV` (le code de réinitialisation n'est renvoyé qu'en développement).

### 3. App mobile

```bash
cd mobile
npm install
npx expo run:android       # development build (une fois)
npx expo start --dev-client
```

Scannez le QR code avec le development build sur Android. L'app détecte automatiquement l'IP du PC via Expo ; si besoin, forcez l'URL avec `EXPO_PUBLIC_API_URL=http://<ip-du-pc>:3001 npx expo start --dev-client`.

## Utilisation

1. Créez un compte (ou deux, pour tester une conversation) : inscription / connexion
2. Bouton « + Nouveau » : cherchez un utilisateur par pseudo, tapez dessus
3. Envoyez des messages, des photos ou des vocaux : ils arrivent en temps réel chez l'autre utilisateur
4. Appui long sur un message : répondre, copier, supprimer pour soi ou pour tous

## Scripts utiles

| Commande | Où | Description |
| --- | --- | --- |
| `npm run start:dev` | api | API en mode watch |
| `npm run db:generate` | api | Générer une migration après modif du schéma |
| `npm run db:push` | api | Appliquer le schéma directement (dev) |
| `npm run test:e2e` | api | Tests e2e REST (DB requise) |
| `npm run smoke` | api | Test WebSocket de bout en bout (API requise) |
| `npm run push:smoke` | api | Test des notifications push (API requise, token FCM) |
| `npm run reliability:smoke` | api | Idempotence, accusés, citations, suppression, vocaux (API requise) |
| `npm run security:smoke` | api | Médias signés, rate limit, rôles, en-têtes, jetons (API requise) |
| `npm run lint` | api | Lint (oxlint) |
| `npx tsc --noEmit` / `npx expo lint` / `npx expo-doctor` | mobile | Typecheck / lint / diagnostic Expo |

## API en un coup d'œil

REST (Bearer token) :

- `POST /auth/register`, `POST /auth/login`, `GET /auth/me`
- `POST /auth/refresh` (`refreshToken`, rotation), `POST /auth/logout` (`refreshToken`)
- `GET /users/search?q=`, `GET /users/me`, `PATCH /users/me` (`displayName`), `POST /users/me/avatar` (`data` base64, `mimeType`)
- `GET /users/blocked`, `POST /users/:id/block`, `DELETE /users/:id/block`
- `POST /users/me/push-token` (`token`, `platform?`), `DELETE /users/me/push-token`
- `POST /conversations` (`memberIds`, `name?`, `type?` DIRECT|GROUP), `GET /conversations` (incl. `unreadCount`, `pinned`, `muted`, `hidden`, `members[].lastReadAt`, `myRole`)
- `GET /conversations/hidden`, `GET /conversations/sync?since=<ISO>&limit=`
- `GET /conversations/:id`, `GET /conversations/:id/messages?before=&after=&limit=`, `GET /conversations/:id/receipts`
- `PATCH /conversations/:id` (`name`), `POST /conversations/:id/members` (`memberIds`), `DELETE /conversations/:id/members/:userId` — pilotage réservé aux administrateurs du groupe
- `PATCH /conversations/:id/preferences` (`pinned?`, `muted?`, `hidden?`) — préférences propres à l'utilisateur
- `POST /conversations/:id/read` — marque la conversation comme lue
- `POST /conversations/read-all` — marque toutes les conversations comme lues
- `POST /uploads` (multipart `file`, champs `width`/`height`/`duration`/`mime`) — images (≤ 15 Mo) et vocaux ; renvoie l'attachement et son URL signée
- `GET /media?f=&e=&s=` — média signé, à expiration (aucune authentification : la signature autorise)

WebSocket (Socket.IO, auth par `auth.token` avec access token 15 min) :

- `conversation:join` `{ conversationId }` — rejoindre un salon
- `conversation:focus` / `conversation:blur` `{ conversationId }` — l'écran est ouvert/fermé (sert à filtrer le push)
- `message:send` `{ conversationId, content, clientId?, replyToId?, attachmentId? }` — envoyer (ack = message créé, ou `{ error }`) ; `clientId` rend l'envoi idempotent
- `message:new` — message reçu dans un salon rejoint
- `message:ack` `{ messageIds }` — le destinataire confirme la réception → `receipt` à l'expéditeur
- `message:read` `{ conversationId }` — marque lu ; broadcast `read` `{ conversationId, userId, at }` et `receipt`
- `message:delete` `{ conversationId, messageId, forEveryone }` — retrait pour tous (auteur) ou pour soi ; broadcast `message:deleted`
- `typing` `{ conversationId, text }` — émis par le client pendant la saisie (throttle 150 ms, `text: ''` = arrêt) ; rebroadcast `typing` `{ conversationId, userId, text }`

## Fonctionnalités livrées au-delà du MVP initial

- Refresh tokens (access 15 min + refresh 30 j avec rotation, `POST /auth/refresh`, `POST /auth/logout`)
- Profil : avatar uploadé sur disque, servi par URL signée, édition du nom affiché
- Groupes : création, renommage, ajout/retrait de membres, **rôles administrateur/membre** (seul un admin pilote le groupe, et le dernier admin qui part en promeut un autre)
- Messages : photos (galerie ou appareil photo), **messages vocaux** (enregistrement, durée, lecture), citations/réponses, copie
- Modération : suppression pour soi (masquée de la seule vue de l'auteur de la demande) ou pour tous (auteur uniquement, tombstone « Message supprimé »)
- Fiabilité : **file d'envoi persistée sur l'appareil** (SQLite, survit à la coupure et à la fermeture de l'app), `clientId` idempotent côté serveur, rattrapage `GET /conversations/sync`
- Accusés de réception message par message : reçu (double coche grise) et lu (double coche bleue), diffusés en temps réel
- Notifications push (Expo/FCM) avec aperçu, avatar de l'expéditeur et nom du groupe ; filtrées quand la conversation est ouverte
- Liste de conversations façon WhatsApp : sections, filtres, non-lus, épinglage, sourdine, **masquage**, actions sur appui long
- Sécurité : URLs de médias signées et expirantes, rate limiting, en-têtes Helmet, CORS restreint par `CORS_ORIGINS`, jetons push liés à leur compte, blocage/déblocage d'utilisateurs
- Paramètres : compte, notifications, confidentialité, utilisateurs bloqués, conversations masquées

## Limites du MVP / prochaines étapes

- Chiffrement de bout en bout
- Recherche dans les messages, appels audio/vidéo
- Envoi réel des codes de réinitialisation (actuellement renvoyés dans la réponse en développement uniquement)
- Médias en stockage local (à migrer vers S3/CDN en production)
- Build iOS (EAS, même code), CI/CD, déploiement API (Docker)
- Mise à jour régulière des correctifs Expo (`npx expo install --fix`)

> Note technique : l'ORM est **Drizzle** (TypeScript pur) plutôt que Prisma, dont les moteurs binaires étaient bloqués dans l'environnement de développement initial ; Drizzle reste un choix moderne et léger pour ce projet.
