# Inventaire d'accessibilité — fusion des écrans de conversation

Version 1.0 — 2026-11-13. Inventaire des `accessibilityRole`, `accessibilityLabel`, `accessibilityHint`, `accessibilityState` et régions live présents dans les deux anciens écrans, et vérification de leur présence dans les composants de B.3.4.

## Ancien écran clair (`chat/[id].tsx`)

| Élément | Propriété | Repris dans |
|---|---|---|
| Coches d'envoi (`Ticks`) | `accessible` + `accessibilityLabel` (envoyé/reçu/lu/en attente/échec) | `ReceiptBadge` (chat-message-row) |
| Chips de réaction | `role=button`, label sticker + compteur | `ReactionChips` |
| « Vu par N » | `role=button`, label | `ChatMessageRow` (onSeenBy) |
| Appels d'en-tête (vocal/vidéo, groupe/direct) | `role=button`, label explicite | `ChatScreen` (B.3.5) |
| Réessayer / supprimer un envoi | labels « Réessayer l'envoi… », « Supprimer ce … » | `RetryActions` + labels fr |
| Pastille de retour en bas | `role=button`, label | `ChatScreen` (B.3.5) |
| Bandeau hors ligne | `accessibilityLiveRegion=polite` | `ChatScreen` (B.3.5) |
| Erreur | `accessibilityLiveRegion=polite` | `ChatScreen` (B.3.5) |
| Indicateur de frappe | `accessibilityLiveRegion=polite` | `ChatScreen` (B.3.5, à brancher) |
| Options de message (SwipeableBubble) | `accessibilityLabel` | `MessageBody` (`fr.chat.unified.messageOptions`) |
| Actions de la feuille | `role=button`, label | `ActionSheet` partagé |
| Ligne de discussion | role/label/hint | `ConversationRow` (déjà livré) |

## Ancien écran chiffré (`e2ee-chat/[id].tsx`)

| Élément | Propriété | Repris dans |
|---|---|---|
| Titre « voir le profil » | `titleAccessibilityLabel` | `ChatHeaderBar` |
| Appels inertes | `role=button`, `state.disabled`, labels « bientôt disponible » | `ChatScreen` (B.3.5) |
| Options de message | `accessibilityLabel` | `MessageBody` |
| Accusés « Reçu » / « Ouvert » | texte lisible (pas de rôle) | `ReceiptBadge` |
| Cibles de transfert | `role=button`, label | `ChatScreen` (B.3.5, si transfert conservé) |
| Bouton « Réessayer » fatal | `role=button` | `ChatScreen` (B.3.5) |

## Nouveaux composants B.3.4

- `ChatSecurityBanner` : `role=text`, label de sécurité.
- `ChatHeaderBar` : sous-titre de sécurité toujours annoncé ; label de titre enrichi.
- `ChatMessageRow` : options, réactions, accusés, réessayer/supprimer, vu par.
- `ChatInputBar` : compositeur et panneaux partagés (accessibilité existante conservée).
- `ChatMessageList` : liste virtualisée, clés stables.

## Pertes volontaires ou reportées

1. **Indicateur de frappe** : pas encore rendu dans les composants B.3.4 ; à brancher dans `ChatScreen` (B.3.5) avec la région live existante. En mode chiffré, il reste absent (capacité `typing=false`).
2. **« Vu par N »** : nécessite le compteur d'accusés ; prévu dans `ChatScreen` (B.3.5) via `seenByCount`.
3. **Sélecteur de réactions dans la feuille** : porté en B.3.5 avec `ChatScreen`, car il dépend du mode et du menu.
4. **Transfert chiffré et fiche d'informations** : reportés à B.3.5 (l'interface de transport expose `loadDraft`, pas encore les métadonnées de transfert) ; aucune perte silencieuse : l'action ne sera pas affichée si non portée.

Toute autre disparition constatée lors de la validation appareil doit être ajoutée ici avant la suppression des anciens écrans (B.3.6).
