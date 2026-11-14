# Backlog chat — écran unifié et E2EE

Version 1.0 — 2026-11-14. Priorités proposées : **P0** sécurité ou perte de données imminente, **P1** fonctionnalité visible incomplète, **P2** finition ou dette.

| Priorité | Élément | Manque constaté |
|---|---|---|
| P1 | Pagination chiffrée | `E2eeTransport.loadOlder` renvoie une page vide ; l'historique local reste limité au chargement initial. |
| P2 | Frappe chiffrée | L'indicateur de frappe reste absent en E2EE (comportement volontaire actuel, à décider). |
| P2 | Album en grille simplifiée | Les albums sont rendus dans une grille simplifiée, sans toutes les interactions de l'ancien écran. |
| P2 | Fiche d'informations minimale | La fiche d'informations d'un message reste minimale dans l'écran unifié. |
| P2 | 5 erreurs de lint préexistantes | `chats.tsx:143` (set-state-in-effect) ; `swipeable-row.tsx:52`, `:83`, `:88` (immutability) ; `swipeable-row.tsx:59` (set-state-in-effect). |

Suivi de session : le doublon transitoire d'un envoi clair est corrigé par `1f67b73` et couvert par `messages-state.test.ts` ; le menu « Retirer pour tous » est conforme entre l'ancien écran et l'écran unifié.
