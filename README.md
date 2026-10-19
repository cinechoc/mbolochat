# MboloChat

Application de messagerie temps réel (MVP) : conversations 1-1 et groupes.

- **Mobile** : React Native + Expo (Android d'abord, iOS plus tard avec le même code)
- **API** : NestJS + Drizzle ORM + PostgreSQL + Socket.IO
- **Temps réel** : WebSocket via Socket.IO (envoi/réception instantanés)

## Structure

```
mbolochat/
├── api/          # Backend NestJS (REST + WebSocket)
│   ├── src/      # auth, users, conversations, chat (gateway), db
│   ├── drizzle/  # Migrations SQL générées
│   └── test/     # Tests e2e (REST)
├── mobile/       # App Expo (React Native) — nom affiché : MboloChat
│   └── src/
│       ├── app/  # Écrans (expo-router) : login, register, chats, new-chat, chat/[id]
│       └── lib/  # API client, auth, socket, types
└── docker-compose.yml  # PostgreSQL pour le dev
```

## Prérequis

- Node.js 20+
- PostgreSQL (via Docker : `docker compose up -d`, ou une instance locale)
- Pour tester sur Android : l'app **Expo Go** + téléphone et PC sur le même Wi-Fi

## Démarrage

### 1. Base de données

```bash
docker compose up -d
```

### 2. API

```bash
cd api
npm install
cp .env.example .env   # puis adapter si besoin (DATABASE_URL, JWT_SECRET)
npm run start:dev
```

Les migrations SQL s'appliquent automatiquement au démarrage. L'API écoute sur `http://localhost:3000`.

### 3. App mobile

```bash
cd mobile
npm install
npx expo start
```

Scannez le QR code avec Expo Go sur Android. L'app détecte automatiquement l'IP du PC via Expo ; si besoin, forcez l'URL avec `EXPO_PUBLIC_API_URL=http://<ip-du-pc>:3000 npx expo start`.

## Utilisation

1. Créez un compte (ou deux, pour tester une conversation) : inscription / connexion
2. Bouton « + Nouveau » : cherchez un utilisateur par pseudo, tapez dessus
3. Envoyez des messages : ils arrivent en temps réel chez l'autre utilisateur

## Scripts utiles

| Commande | Où | Description |
| --- | --- | --- |
| `npm run start:dev` | api | API en mode watch |
| `npm run db:generate` | api | Générer une migration après modif du schéma |
| `npm run db:push` | api | Appliquer le schéma directement (dev) |
| `npm run test:e2e` | api | Tests e2e REST (DB requise) |
| `npm run smoke` | api | Test de bout en bout WebSocket (API requise) |
| `npm run lint` | api | Lint (oxlint) |
| `npx expo start` | mobile | Serveur de dev Expo |
| `npx tsc --noEmit` / `npx eslint src` | mobile | Typecheck / lint |

## API en un coup d'œil

REST (Bearer token) :

- `POST /auth/register`, `POST /auth/login`, `GET /auth/me`
- `POST /auth/refresh` (`refreshToken`, rotation), `POST /auth/logout` (`refreshToken`)
- `GET /users/search?q=`, `GET /users/me`, `PATCH /users/me` (`displayName`), `POST /users/me/avatar` (`data` base64, `mimeType`)
- `POST /conversations` (`memberIds`, `name?`, `type?` DIRECT|GROUP), `GET /conversations` (incl. `unreadCount`, `pinned`, `muted`, `members[].lastReadAt`)
- `GET /conversations/:id`, `GET /conversations/:id/messages?before=&limit=`
- `PATCH /conversations/:id` (`name`), `POST /conversations/:id/members` (`memberIds`), `DELETE /conversations/:id/members/:userId`
- `PATCH /conversations/:id/preferences` (`pinned?`, `muted?`) — préférences propres à l'utilisateur
- `POST /conversations/:id/read` — marque la conversation comme lue
- `POST /conversations/read-all` — marque toutes les conversations comme lues

WebSocket (Socket.IO, auth par `auth.token` avec access token 15 min) :

- `conversation:join` `{ conversationId }` — rejoindre un salon
- `message:send` `{ conversationId, content }` — envoyer (ack = message créé)
- `message:new` — message reçu dans un salon rejoint
- `typing` `{ conversationId, text }` — émis par le client pendant la saisie (throttle 150 ms, `text: ''` = arrêt) ; rebroadcast `typing` `{ conversationId, userId, text }` pour afficher le texte en direct
- `message:read` `{ conversationId }` — marque lu ; broadcast `read` `{ conversationId, userId, at }`

## Fonctionnalités livrées au-delà du MVP initial

- Refresh tokens (access 15 min + refresh 30 j avec rotation, `POST /auth/refresh`, `POST /auth/logout`)
- Profil : avatar uploadé sur disque (`api/uploads/`, servi en `/uploads`), édition du nom affiché
- Groupes : création côté UI (multi-sélection + nom), renommage, ajout/retrait de membres
- Pagination inversée de l'historique (`before`/`limit` au scroll vers le haut)
- Indicateur de frappe (`typing`) et accusés de lecture (`message:read` → ✓✓) + badge non-lus
- Liste de conversations façon WhatsApp : sections (Épinglées / Aujourd'hui / Hier / 7 derniers jours / Plus ancien), filtres (Toutes / Non lus / Groupes), badge de non-lus total dans l'en-tête, pull-to-refresh, horodatage intelligent
- Actions sur appui long : marquer comme lu, épingler/désépingler, couper les notifications, infos, quitter la discussion
- Préférences par utilisateur et par conversation (épinglage, muet) stockées en base (`conversation_members.pinned_at` / `muted_at`)
- ✓✓ dans l'aperçu de la liste (lu par tous les autres), mis à jour en temps réel via l'événement `read`

## Limites du MVP / prochaines étapes

- Chiffrement de bout en bout
- Recherche dans les messages, notifications push
- Build iOS (EAS, même code), CI/CD, déploiement API (Docker)
- Avatars servis depuis le disque local (à migrer vers S3/CDN en prod)

> Note technique : l'ORM est **Drizzle** (TypeScript pur) plutôt que Prisma, dont les moteurs binaires étaient bloqués dans l'environnement de développement initial ; Drizzle reste un choix moderne et léger pour ce projet.
