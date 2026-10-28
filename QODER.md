# Consignes projet

## Ressources machine
Cette machine a des ressources limitées. Ne lance PAS de build lourd :
- pas de `expo export`, `eas build`, `gradle`, bundling Metro complet
- pas de `npm run build` sur l'API sans besoin strict

Préférer :
- tests unitaires légers (`node --test` sur les tests `.mjs` de `mobile/tests/`)
- vérification TypeScript en `tsc --noEmit` uniquement
- relecture du code plutôt que compilation pour valider un changement
