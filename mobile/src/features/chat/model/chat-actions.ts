import type { SheetAction, SheetIcon } from '@/components/action-sheet';
import { fr } from '@/i18n/fr';
import { EDIT_WINDOW_MS, MAX_EDIT_REVISION } from '@/features/e2ee/payload';
import type { ChatCapabilities, ChatMessageView } from '../transport/types';

export interface ChatActionIcons {
  reply?: SheetIcon;
  copy?: SheetIcon;
  edit?: SheetIcon;
  trash2?: SheetIcon;
}

export function canEditMessage(message: ChatMessageView, now = Date.now()): boolean {
  const createdAt = Date.parse(message.createdAt);
  return (
    Number.isFinite(createdAt) &&
    now >= createdAt &&
    now - createdAt <= EDIT_WINDOW_MS
  );
}

export interface ChatActionsInput {
  message: ChatMessageView | null;
  capabilities: ChatCapabilities;
  icons?: ChatActionIcons;
  onReply: (message: ChatMessageView) => void;
  onCopy: (message: ChatMessageView) => void;
  onEdit: (message: ChatMessageView) => void;
  /** Ouvre le choix « pour moi » / « pour tout le monde ». */
  onDelete: (message: ChatMessageView) => void;
  extra?: SheetAction[];
  /** Horloge injectable pour tester la fenêtre de modification. */
  now?: number;
}

/**
 * Actions du menu d’appui long, filtrées **uniquement** par `capabilities`.
 * Fonction pure : le hook ne fait que memoïser le résultat.
 */
export function buildChatActions({
  message,
  capabilities,
  icons,
  onReply,
  onCopy,
  onEdit,
  onDelete,
  extra = [],
  now = Date.now(),
}: ChatActionsInput): SheetAction[] {
  if (!message || message.deleted) return [];
  const waiting = message.state === 'pending' || message.state === 'failed';
  const viewOnce = message.viewOnce === true;
  const actions: SheetAction[] = [];
  if (capabilities.replies && !waiting && !viewOnce) {
    actions.push({
      key: 'reply',
      label: fr.chat.menu.reply,
      icon: icons?.reply,
      onPress: () => onReply(message),
    });
  }
  if (message.body && !viewOnce) {
    actions.push({
      key: 'copy',
      label: fr.chat.menu.copy,
      icon: icons?.copy,
      onPress: () => onCopy(message),
    });
  }
  actions.push(...extra);
  if (
    capabilities.edit &&
    message.mine &&
    !waiting &&
    !message.unreadable &&
    !viewOnce &&
    message.type === 'text' &&
    !message.attachment &&
    !message.stickerRef &&
    message.body.trim().length > 0 &&
    message.editRevision < MAX_EDIT_REVISION &&
    canEditMessage(message, now)
  ) {
    actions.push({
      key: 'edit',
      label: fr.chat.menu.edit,
      icon: icons?.edit,
      onPress: () => onEdit(message),
    });
  }
  actions.push({
    key: 'delete',
    label: fr.chat.menu.delete,
    icon: icons?.trash2,
    destructive: true,
    onPress: () => onDelete(message),
  });
  return actions;
}
