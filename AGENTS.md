# AGENTS.md — MboloChat

Monorepo applicatif **sans workspace npm racine** : chaque projet s'installe et se lance dans son dossier.

| Dossier | Rôle | Stack |
| --- | --- | --- |
| `api/` | REST + Socket.IO | NestJS 12, Drizzle ORM, PostgreSQL 16 |
| `mobile/` | Client Android d'abord, web ensuite | Expo SDK 58, React Native 0.88, expo-router |
| `crypto/` | Cœur E2EE | Rust 1.89 (vodozemac), exposé via `mobile/modules/mbolo-crypto` |

Node 20+ (la CI utilise Node 24). Pas de `package.json` à la racine : ne jamais lancer `npm install` depuis la racine.

## Démarrage

```bash
docker compose up -d                  # PostgreSQL 16 sur :5432 (mbolochat/mbolochat)
cd api && cp .env.example .env && npm install && npm run start:dev
# API sur http://localhost:3001 — les migrations Drizzle s'appliquent au démarrage

cd mobile && npm install && npx expo run:android   # development build, obligatoire
npx expo start --dev-client
```

- **Expo Go ne suffit pas** : le projet dépend de modules natifs absents d'Expo Go (`mbolo-crypto`, WebRTC/appels, SQLCipher, configuration FCM).
- L'app déduit l'IP de l'API depuis Expo. Sinon : `EXPO_PUBLIC_API_URL=http://<ip>:3001 npx expo start --dev-client`.
- `.env` est ignoré par Git. `api/.env` doit contenir `DATABASE_URL`, `JWT_SECRET`, `PORT`, `CORS_ORIGINS`.
- `E2EE_ENABLED=false` par défaut : les routes `/e2ee` répondent 404 tant qu'il n'est pas à `true`.

## Vérifications

```bash
# API (depuis api/)
npm run lint                  # oxlint --type-aware
npm run format                # Prettier (src/ et test/)
npx tsc --noEmit
npm test                      # specs Vitest, sans base
npm run test:e2e              # e2e, PostgreSQL requis
npx vitest run src/users/location-policy.spec.ts   # un seul fichier
# smokes, API déjà démarrée : npm run smoke | reliability:smoke | security:smoke | push:smoke | calls:smoke

# Mobile (depuis mobile/)
npx tsc --noEmit
npx expo lint
npx expo-doctor
npm test                      # Vitest : logique pure uniquement, pas de rendu RN
node --test tests/*.test.mjs  # contrôles assets/emoji (node:test)

# Crypto (depuis crypto/)
bash scripts/check.sh         # fmt + clippy + tests + licences
```

Le seul workflow CI est `.github/workflows/crypto.yml`. **Aucun CI TypeScript** : les commandes ci-dessus sont le vrai garde-fou, à lancer avant de conclure.

## Architecture

- `api/src/main.ts` : bootstrap, CORS, Helmet, migrations, service du bundle web `../mobile/dist`. **L'API doit tourner avec `api/` comme cwd** ("drizzle" et "uploads" sont relatifs).
- `api/src/<domaine>/` : module + controller + service. Gateways Socket.IO dans `api/src/chat` et `api/src/calls`.
- `api/src/db/schema.ts` : source unique du schéma ; les migrations SQL sont dans `api/drizzle/`.
- Médias et avatars sont stockés sur disque dans `api/uploads/` (ignoré par Git) et servis par URL signée : pas de stockage objet.
- `mobile/src/app/` : routes expo-router (`typedRoutes`) ; `features/<domaine>/` : logique métier ; `lib/` : api, socket, outbox, store SQLite, jetons ; `components/` : UI partagée.
- `crypto/` : bibliothèque Rust ; le wrapper Expo et les `.so` arm64/x86_64 précompilés sont dans `mobile/modules/mbolo-crypto/`.

## Règles projet non négociables

- **E2EE** : le serveur ne doit jamais déchiffrer ni journaliser de clair, ni recevoir de clé privée. Clés protégées par le Keystore Android + SQLCipher. Ne jamais désactiver ou contourner le chiffrement ; toute modification crypto exige des tests et une vérification réelle.
- **Messagerie** : les messages classiques passent par l'outbox SQLite (`mobile/src/lib/outbox.ts` + `store.ts`), avec `clientId` idempotent. Ne pas envoyer directement par le socket, ne pas contourner la reprise hors ligne. Le chemin E2EE (`features/e2ee/text.ts`) envoie encore directement via le socket avec `clientId` : traiter les deux chemins, ne pas généraliser l'un en oubliant l'autre.
- **Secrets** : rien de sensible dans le code. Les variables `EXPO_PUBLIC_*` sont embarquées dans le client et donc publiques. Ne jamais committer `.env`, clés Firebase ni `service-account*.json`.
- **Config** : URL, délais, limites et règles métier en constantes nommées ou variables d'environnement. Le backend est l'autorité pour l'autorisation et la validation.
- **UI** : textes en français ; nouveaux libellés centralisés dans `mobile/src/i18n/fr.ts`. Couleurs, rayons et espacements via `mobile/src/constants/theme.ts` (`useTheme`, `ThemedText`, `ThemedView`), jamais en dur, thèmes clair et sombre.

## UI/UX & qualité du code — règles strictes

Ces règles complètent la règle **UI** ci-dessus et s'appliquent à toute modification visible ou comportementale.

### 1. Interface professionnelle

- Produire des interfaces de qualité production, pas des prototypes génériques.
- Suivre les principes du design mobile moderne.
- Maintenir une cohérence visuelle dans toute l'application.
- Éviter les mises en page amateurs, la décoration inutile et les espacements incohérents.
- Chaque écran doit paraître fini et soigné.

### 2. Design system

- Centraliser les design tokens.
- Réutiliser les couleurs, la typographie, les espacements, les dimensions, les rayons et les ombres.
- Ne jamais dupliquer inutilement des valeurs de design.
- Prendre en charge les thèmes clair et sombre de façon cohérente.
- Si un token manque, l'ajouter à `mobile/src/constants/theme.ts` plutôt que d'écrire une valeur en dur.

### 3. Performance

- Réduire les rendus inutiles des composants.
- Optimiser les listes, les images, la navigation et les animations.
- Ne pas exécuter d'opérations coûteuses sur le thread UI.
- N'utiliser la mémoïsation que lorsqu'elle apporte un gain mesurable.
- Éviter les dépendances inutiles et l'abstraction excessive.

### 4. Architecture

- Construire des composants réutilisables et maintenables.
- Séparer la logique métier de la présentation.
- Éviter la duplication de code.
- Garder des composants ciblés et de taille raisonnable.
- Respecter l'architecture existante (`src/app`, `features`, `lib`, `components`).

### 5. Qualité UX

- Implémenter les états de chargement, vide, erreur, succès et hors ligne.
- Fournir un retour visuel clair pour chaque interaction.
- Garantir une navigation fluide et des interactions intuitives.
- Prévenir les décalages de mise en page et les incohérences visuelles.

### 6. Accessibilité & responsive

- Prendre en charge différentes tailles d'écran.
- Respecter la mise à l'échelle système des polices lorsque c'est approprié.
- Maintenir un contraste suffisant.
- Fournir des libellés accessibles et des zones tactiles suffisamment grandes.

### 7. Validation

- Inspecter l'application réellement en cours d'exécution.
- Tester les interactions et la navigation réelles.
- Vérifier les débordements, les coupures et les défauts visuels.
- Lancer les vérifications de types, le lint et les tests pertinents.
- Ne jamais déclarer une fonctionnalité terminée sans l'avoir vérifiée.

### 8. Discipline de développement

- Inspecter le code existant avant toute modification.
- Éviter les réécritures inutiles.
- Préserver les fonctionnalités qui marchent.
- Ne jamais introduire de fausses données ni de placeholders codés en dur dans une fonctionnalité de production.
- Préférer des solutions simples, efficaces et maintenables à une complexité inutile.

## Pièges spécifiques

- **Machine aux ressources limitées** : ne jamais lancer `expo prebuild` ni build lourd localement. Si un build est nécessaire, `npm run build:android` dans Waydroid (déjà en marche sur la machine), ou demander à l'utilisateur de lancer un build EAS de son côté.
- `mobile/android/` et `mobile/ios/` sont **générés et ignorés par Git**. Ne jamais les éditer à la main. Après `app.json`, `plugins/` ou une dépendance native : `npx expo prebuild --platform android --no-install`, puis reconstruire l'APK. Les plugins `mobile/plugins/with*` injectent le service de notifications et `CallActionsReceiver`.
- **Drizzle** : modifier `schema.ts` → `npm run db:generate` → relire le SQL → committer la migration et `meta/_journal.json`. Ne jamais modifier une migration déjà appliquée. Les fichiers `.down.sql` sont manuels et ne sont pas exécutés automatiquement. `npm run db:push` est un raccourci de dev, pas une migration versionnée.
- Une modification Rust impose de reconstruire les `.so` avec `bash crypto/scripts/build-android.sh` (NDK Android requis) et de committer les deux ABI. Une modification JS seule ne l'impose pas.
- Une modification de `crypto/` doit passer `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test --features jni` et le contrôle de licences.
- Le bundle web (`mobile/dist`) est servi par l'API si présent ; l'origine web doit figurer dans `CORS_ORIGINS`.
- En production : `npm run build` puis `npm run start:prod` (`dist/` est ignoré par Git). `NODE_ENV` autre que `development`/`test` supprime le renvoi des codes de réinitialisation.
- Le géocodage inverse appelle Nominatim. `setDefaultResultOrder('ipv4first')` dans `api/src/main.ts` est volontaire (réseaux où IPv6 est annoncé mais non routé) : ne pas le retirer.
- E2E et smokes utilisent la base `DATABASE_URL` et créent de vrais comptes/données ; ne jamais les pointer vers la production. Le rate limit n'est ignoré que si `NODE_ENV=test`.
- L'API utilise NodeNext : les imports relatifs TypeScript gardent le suffixe `.js`.
- `reactCompiler` est activé dans `app.json` : ne pas muter une valeur passée à un hook (règle `react-hooks/immutability`).
- Le lint mobile peut déjà échouer sur des fichiers non liés (`chats.tsx`, `swipeable-row.tsx`, compositeur…). Comparer au bruit existant et ne pas corriger hors sujet.
- Les tests mobiles Vitest ne montent pas de composants React Native ; l'UI se valide par `tsc`, `expo lint` et un test sur appareil.

## Références

- `README.md` : démarrage et panorama des endpoints (peut avoir du retard sur le code).
- `docs/STICKERS.md` : packs de stickers. `docs/TRAVAIL-RESTANT.md` : backlog daté, pas une vérité courante.
- En cas de doute, le code (schéma, controllers, `app.json`, scripts) prime sur la prose.
