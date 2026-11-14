# Backlog chat — écran unifié et E2EE

Version 1.1 — 2026-11-14. Priorités proposées : **P0** sécurité ou perte de données imminente, **P1** fonctionnalité visible incomplète, **P2** finition ou dette.

| Priorité | Élément | Manque constaté |
|---|---|---|
| P1 | Validation appareil E2EE Lots 1 et 2 | Réactions, frappe, stickers, suppression, code de sécurité, éphémères et modifications restent « non vérifiés sur appareil, reportés » ; seuls les tests automatiques font foi pour l’instant. |
| P1 | Échéance éphémère en transit | Le récepteur calcule `expires_at` avec le réglage courant, pas avec le TTL effectif au moment de l’émission : un message reçu après un changement de réglage peut expirer trop tôt ou trop tard. Il faut un historique de versions ou porter l’échéance dans l’enveloppe. |
| P1 | Bandeau de changement de clé dans l’en-tête | « Code de sécurité modifié » est visible dans l’écran de vérification, mais pas de façon persistante dans l’en-tête de la conversation ; l’utilisateur peut envoyer sans revoir l’alerte. |
| P2 | Album en grille simplifiée | Les albums sont rendus dans une grille simplifiée, sans toutes les interactions de l’ancien écran. |
| P2 | Fiche d’informations minimale | La fiche d’informations d’un message reste minimale dans l’écran unifié. |
| P2 | Stickers personnels en chiffré | La capability `stickers` ouvre le sélecteur complet, mais un sticker personnel échoue encore avec une alerte : `v:3` ne transporte que des références de catalogue. |
| P2 | Validation de non-régression sur un deuxième téléphone | Les anciens écrans ont été supprimés sans passe appareil réelle ; prévoir un contrôle des parcours clairs, groupes et chiffrés sur un second téléphone avant mise en service. |
