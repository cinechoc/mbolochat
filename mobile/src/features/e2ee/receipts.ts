import type { MessageReceipt } from '@/lib/types';

/**
 * Accusés de réception E2EE : « Reçu » puis « Ouvert ».
 *
 * Le serveur ne connaît que des métadonnées techniques (`message_receipts` :
 * qui a reçu, qui a lu), jamais le contenu. Ces fonctions traduisent ces lignes
 * en un état d'affichage, avec la règle produit : « Ouvert » est **définitif**,
 * « Reçu » n'est qu'une étape temporaire.
 */
export type ReceiptState = 'none' | 'delivered' | 'read';

/**
 * État d'un message envoyé, vu par son auteur.
 *
 * - `read` dès qu'un destinataire a ouvert le message — et pour toujours : une
 *   déconnexion ou une absence ultérieure ne fait jamais retomber l'état ;
 * - `delivered` si un destinataire a confirmé la réception **et** est en ligne
 *   (son application au premier plan) : un destinataire qui se déconnecte
 *   avant d'avoir ouvert le message fait disparaître le « Reçu » de l'affichage,
 *   qui réapparaît à sa reconnexion tant qu'il n'a pas lu ;
 * - `none` sinon (aucun statut affiché, notamment destinataire hors ligne).
 *
 * L'accusé de l'auteur lui-même est ignoré : il ne renseigne sur personne.
 * `peerOnline` vaut `true` par défaut pour préserver les appelants historiques.
 */
export function receiptState(
  receipts: MessageReceipt[] | undefined,
  senderId: string | null | undefined,
  peerOnline = true,
): ReceiptState {
  let delivered = false;
  for (const receipt of receipts ?? []) {
    if (senderId && receipt.userId === senderId) continue;
    if (receipt.readAt) return 'read';
    if (receipt.deliveredAt) delivered = true;
  }
  return delivered && peerOnline ? 'delivered' : 'none';
}

/**
 * Fusionne des accusés entrants dans l'état courant.
 *
 * Un accusé plus ancien ne doit jamais effacer une lecture déjà connue : on
 * conserve la valeur la plus avancée par message et par destinataire.
 */
export function mergeReceipts(
  current: Record<string, MessageReceipt[]>,
  incoming: MessageReceipt[],
): Record<string, MessageReceipt[]> {
  if (incoming.length === 0) return current;
  const next = { ...current };
  for (const receipt of incoming) {
    if (!receipt || typeof receipt.messageId !== 'string') continue;
    const list = next[receipt.messageId] ? [...next[receipt.messageId]] : [];
    const index = list.findIndex((entry) => entry.userId === receipt.userId);
    if (index === -1) {
      list.push(receipt);
    } else {
      const previous = list[index];
      list[index] = {
        ...previous,
        deliveredAt: previous.deliveredAt ?? receipt.deliveredAt,
        readAt: previous.readAt ?? receipt.readAt,
      };
    }
    next[receipt.messageId] = list;
  }
  return next;
}

/**
 * Identifiants à accuser à la réception : uniquement les messages des autres,
 * réellement écrits sur cet appareil (jamais un accusé pour un message qu'on
 * vient d'envoyer, ni pour un message seulement connu du serveur).
 */
export function deliveredIds(
  messages: readonly { id: string; mine: number }[],
): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.mine !== 0) continue;
    if (typeof message.id !== 'string' || message.id.length === 0) continue;
    if (!ids.includes(message.id)) ids.push(message.id);
  }
  return ids;
}

/**
 * Une conversation est « consultée » seulement si l'écran est au premier plan,
 * que l'application est active et que la liste est prête : être connecté, avoir
 * l'application ouverte ou recevoir une notification ne suffit pas.
 */
export function canMarkRead(input: {
  focused: boolean;
  appActive: boolean;
  ready: boolean;
}): boolean {
  return input.focused && input.appActive && input.ready;
}

/**
 * Tot accusé de livraison côté destinataire : la livraison est confirmée sur
 * l'appareil dès que le message y est persisté, mais l'accusé ne part que si
 * l'application est active et que l'écran a fini de charger. Un message reçu
 * en arrière-plan reste en file locale et est accusé au retour au premier
 * plan — jamais pendant que l'application est en arrière-plan.
 */
export function canReportDelivered(input: { appActive: boolean; ready: boolean }): boolean {
  return input.appActive && input.ready;
}
