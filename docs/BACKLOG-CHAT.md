# Backlog chat — écran unifié et E2EE

Version 1.0 — 2026-11-14. Priorités proposées : **P0** sécurité ou perte de données imminente, **P1** fonctionnalité visible incomplète, **P2** finition ou dette.

| Priorité | Élément | Manque constaté |
|---|---|---|
| P1 | B.3.6 : suppression des anciens écrans, après tests sur un deuxième téléphone | Les anciens écrans restent en place et le drapeau unifié est activé par défaut ; retirer les routes historiques seulement après validation sur un second appareil. |
| P1 | Vérification appareil E2EE Lot 1 | Réactions `v:4`, frappe éphémère, stickers `v:3` et suppression `v:5` sont couverts par les tests automatiques mais aucun scénario n'a été rejoué sur téléphone ; tout est « non vérifié sur appareil, reporté ». |
| P1 | Pagination chiffrée | `E2eeTransport.loadOlder` renvoie une page vide ; l'historique local reste limité au chargement initial. |
| P2 | Album en grille simplifiée | Les albums sont rendus dans une grille simplifiée, sans toutes les interactions de l'ancien écran. |
| P2 | Fiche d'informations minimale | La fiche d'informations d'un message reste minimale dans l'écran unifié. |
| P2 | Stickers personnels en chiffré | La capability `stickers` ouvre le sélecteur complet, mais un sticker personnel échoue encore avec une alerte : `v:3` ne transporte que des références de catalogue. |
| P2 | 5 erreurs de lint préexistantes | `chats.tsx:143` (set-state-in-effect) ; `swipeable-row.tsx:52`, `:83`, `:88` (immutability) ; `swipeable-row.tsx:59` (set-state-in-effect). |

Suivi de session : le doublon transitoire d'un envoi clair est corrigé par `1f67b73` et couvert par `messages-state.test.ts` ; le menu « Retirer pour tous » est conforme entre l'ancien écran et l'écran unifié.
