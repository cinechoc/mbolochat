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
- `GET /users/search?q=`, `GET /users/me`
- `POST /conversations` (`memberIds`, `name?`), `GET /conversations`
- `GET /conversations/:id`, `GET /conversations/:id/messages?before=&limit=`

WebSocket (Socket.IO, auth par `auth.token`) :

- `conversation:join` `{ conversationId }` — rejoindre un salon
- `message:send` `{ conversationId, content }` — envoyer (ack = message créé)
- `message:new` — message reçu dans un salon rejoint

## Limites du MVP / prochaines étapes

- Refresh tokens (le JWT actuel expire en 30 jours)
- Création de groupes côté UI (l'API le supporte déjà), avatars, images
- Indicateurs de frappe, accusés de lecture, notifications push
- Chiffrement de bout en bout
- Pagination inversée des messages dans l'UI, recherche dans les messages
- Build iOS (EAS, même code), CI/CD, déploiement API (Docker)

> Note technique : l'ORM est **Drizzle** (TypeScript pur) plutôt que Prisma, dont les moteurs binaires étaient bloqués dans l'environnement de développement initial ; Drizzle reste un choix moderne et léger pour ce projet.
