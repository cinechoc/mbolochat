import type { SheetAction, SheetIcon } from '@/components/action-sheet';
import { fr } from '@/i18n/fr';
import { EDIT_WINDOW_MS, MAX_EDIT_REVISION } from '@/features/e2ee/payload';
import type { ChatCapabilities, ChatMessageView } from '../transport/types';

export interface ChatActionIcons {
  reply?: SheetIcon;
  copy?: SheetIcon;
  edit?: SheetIcon;
  trash?: SheetIcon;
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
  onDeleteForMe: (message: ChatMessageView) => void;
  onDeleteForAll: (message: ChatMessageView) => void;
  extra?: SheetAction[];
  /** Horloge injectable pour tester la fenêtre de modification. */
  now?: number;
}

/**
 * Actions du menu d'appui long, filtrées **uniquement** par `capabilities`.
 * Fonction pure : le hook ne fait que memoïser le résultat.
 */
export function buildChatActions({
  message,
  capabilities,
  icons,
  onReply,
  onCopy,
  onEdit,
  onDeleteForMe,
  onDeleteForAll,
  extra = [],
  now = Date.now(),
}: ChatActionsInput): SheetAction[] {
  if (!message) return [];
  const waiting = message.state === 'pending' || message.state === 'failed';
  const actions: SheetAction[] = [...extra];
  if (capabilities.replies && !waiting && !message.deleted) {
    actions.push({
      key: 'reply',
      label: fr.chat.menu.reply,
      icon: icons?.reply,
      onPress: () => onReply(message),
    });
  }
  if (
    capabilities.edit &&
    message.mine &&
    !waiting &&
    !message.deleted &&
    !message.unreadable &&
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
  if (message.body) {
    actions.push({
      key: 'copy',
      label: fr.chat.menu.copy,
      icon: icons?.copy,
      onPress: () => onCopy(message),
    });
  }
  actions.push({
    key: 'delete-me',
    label: waiting ? fr.chat.menu.delete : fr.chat.menu.deleteForMe,
    icon: icons?.trash2,
    destructive: true,
    onPress: () => onDeleteForMe(message),
  });
  if (capabilities.deleteForEveryone && !waiting && !message.deleted && message.mine) {
    actions.push({
      key: 'delete-all',
      label: fr.chat.menu.deleteForAll,
      icon: icons?.trash,
      destructive: true,
      onPress: () => onDeleteForAll(message),
    });
  }
  return actions;
}
