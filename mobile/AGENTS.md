# AGENTS.md — mobile/

Le guide commun du dépôt est dans [`../AGENTS.md`](../AGENTS.md). Ce fichier ne liste que les spécificités du client.

## Commandes

```bash
npx tsc --noEmit
npx expo lint
npm test                      # Vitest : src/**/*.test.ts, logique pure
node --test tests/*.test.mjs  # contrôles assets/emoji (node:test)
npx vitest run src/features/e2ee/policy.test.ts   # un seul test
npm run android               # = npx expo run:android
```

## Spécificités

- Routes et écrans dans `src/app/` (expo-router, `typedRoutes` activé). Toute nouvelle route est un fichier ici.
- Alias `@/*` → `src/*`, configuré dans `tsconfig.json` et `vitest.config.ts`.
- `android/` et `ios/` sont générés et ignorés par Git : jamais d'édition manuelle. Après `app.json`, `plugins/` ou une dépendance native : `npx expo prebuild --platform android --no-install`, puis rebuild.
- Expo Go ne suffit pas : modules natifs absents (`mbolo-crypto`, WebRTC/appels, SQLCipher, configuration FCM). Utiliser `npx expo run:android` ou un build EAS `development`.
- Textes : `src/i18n/fr.ts` pour les nouveaux écrans ; certains écrans existants ont encore des chaînes inline.
- Thème : `src/constants/theme.ts`, `useTheme`, `ThemedText`, `ThemedView`. Aucune couleur ni dimension codée en dur.
- Messages classiques : toujours passer par `src/lib/outbox.ts` (+ `src/lib/store.ts`), jamais par un `socket.emit` direct. Le chemin E2EE (`src/features/e2ee/text.ts`) est une exception existante.
- E2EE : bootstrap dans `src/features/e2ee`, clés via Keystore + SQLCipher, module natif `modules/mbolo-crypto` (`.so` commités). Les outils de dev ne sont embarqués que si `EXPO_PUBLIC_E2EE_DEV_TOOLS=1`.
- `EXPO_PUBLIC_*` est visible dans le bundle : jamais de secret.
- Les tests Vitest ne montent pas de composants React Native ; valider l'UI avec `tsc`, `expo lint` et un test sur appareil.
