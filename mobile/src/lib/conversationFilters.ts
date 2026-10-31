/**
 * Non-lus cumulés des conversations de groupe, pour la puce de filtre
 * « Groupes » : on compte les messages non lus, pas les groupes existants.
 */
export function groupUnreadCount(
  conversations: readonly { type: string; unreadCount: number }[],
): number {
  return conversations
    .filter((conversation) => conversation.type === 'GROUP')
    .reduce((total, conversation) => total + Math.max(0, conversation.unreadCount), 0);
}
