# Travail restant — MboloChat

État au 31 octobre 2026, après le commit `feat: messagerie et appels de groupe, moteur d'appel unifié`.

## 1. Vérification matérielle des appels vocaux (bloquant avant la suite)

L'audit vocal a été corrigé et couvert par des tests unitaires, mais le scénario
manuel n'a pas pu être rejoué : la session Waydroid s'est retrouvée déconnectée
après les redémarrages de l'API.

À rejouer sur **Galaxy (3 boutons et gestes)** et **Waydroid**, avec deux comptes :

- [ ] appel un à un : décroché, qualité, haut-parleur, raccrocher ;
- [ ] appel de groupe à 3 : grille, anneau de parole, quitter sans couper ;
- [ ] coupure du Wi-Fi en plein appel : « Reconnexion… » puis retour ;
- [ ] passage Wi-Fi → 4G : redémarrage ICE sans couper ;
- [ ] branchement / débranchement d'un casque filaire ;
- [ ] appel GSM entrant pendant un appel (comportement attendu ci-dessous) ;
- [ ] mode audio seul et plafond audio 8.

## 2. Corrections vocales restantes

| Réf. | Sujet | Pourquoi c'est en attente |
|---|---|---|
| C1 | Interruption GSM / perte de focus audio : pause affichée « Audio interrompu » | Nécessite un callback natif de focus audio (`AudioManager`) — lot natif |
| C8 | Détection de changement de réseau → redémarrage ICE immédiat | `@react-native-community/netinfo` est un module natif — lot natif |
| C9 | Écoute des pistes distantes `mute`/`ended` (micro distant perdu) | JS seul, petit chantier, non commencé |
| C10 | Suivi des changements de route casque / Bluetooth | L'événement `WiredHeadset` d'InCallManager n'est pas encore branché |

Le verrou d'écran (`expo-keep-awake`) est en place ; le capteur de proximité
éteint l'écran à l'oreille comme prévu.

## 3. Tranche 6 — persistance des appels

- [ ] migration `0024_call_sessions.sql` : `call_sessions` + `call_participants`
      (mode, média, état, démarré par, début/fin, durée ; arrivée/départ par
      participant) ;
- [ ] `calls.repository.ts` en écriture **fire-and-forget**, partagé par
      `CallsService` et `GroupCallsService` ;
- [ ] tests e2e : un appel de groupe laisse la session et ses participants en base ;
- [ ] vérification du message système final (`Appel terminé · durée`) après
      redémarrage du serveur en cours d'appel.

## 4. Tranche 7 — lot natif (un seul rebuild EAS, à lancer par Bruneel)

- [ ] service de premier plan Android (`MICROPHONE` / `PHONE_CALL`) avec
      notification permanente « Appel en cours » et bouton raccrocher ;
- [ ] appel entrant groupe : notification plein écran pour les groupes (le push
      actuel ne concerne que le 1:1) ;
- [ ] `@react-native-community/netinfo` (C8) ;
- [ ] `expo-screen-orientation` : paysage géré sans couper l'appel ;
- [ ] callback de focus audio natif (C1).

Après rebuild : réinstaller l'APK sur les deux appareils et rejouer la section 1.

## 5. Vidéo de groupe — points différés

- [ ] coupure automatique des vidéos hors écran (sans objet tant que le plafond
      est à 4 participants ; à brancher avec le SFU) ;
- [ ] préparation SFU : le moteur ne connaît que `send(event, { to })`, la porte
      est ouverte mais rien n'est implémenté.

## 6. Qualité de code et finition

- [ ] **dette lint préexistante** : 32 erreurs hors périmètre appel
      (`chats.tsx` 3, `ChatComposer` 10, `swipeable-row` 4, scripts 17) ;
- [ ] i18n : fichier de chaînes français et extraction des textes ;
- [ ] nettoyage des couleurs/tailles codées en dur restantes hors écrans d'appel ;
- [ ] accessibilité des écrans de groupe (libellés, ordre de focus) ;
- [ ] scénario de bout en bout : créer un groupe de 3, envoyer un message,
      ajouter un membre, quitter.

## 7. Sessions et incidents observés

- [ ] **Déconnexion involontaire** : Waydroid s'est retrouvé sur l'écran de
      connexion après des redémarrages d'API. À vérifier : l'app ne doit pas
      effacer les jetons sur une simple erreur réseau (`auth-context`).
- [ ] Purge optionnelle des comptes de test (`*@smoke.dev`, `*@e2e.dev`) et des
      groupes de test restants.

## 8. Pour reprendre

```bash
# API (actuellement arrêtée)
cd api && setsid node dist/main > /tmp/mbolochat-api.log 2>&1 < /dev/null &

# Mobile
cd mobile && npx expo start --dev-client

# Tunnels des appareils (après redémarrage d'adb)
adb -s <appareil> reverse tcp:8081 tcp:8081
adb -s <appareil> reverse tcp:3001 tcp:3001

# Vérifications
cd api && npm run lint && npm run build && npm run test:e2e
cd mobile && npx tsc --noEmit && npm test && npx expo lint
```
