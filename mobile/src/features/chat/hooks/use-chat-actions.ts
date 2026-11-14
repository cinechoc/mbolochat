import { Copy, Pencil, Reply, Trash2 } from 'lucide-react-native';
import { useMemo } from 'react';

import type { SheetAction } from '@/components/action-sheet';
import { buildChatActions, type ChatActionIcons, type ChatActionsInput } from '../model/chat-actions';

const ACTION_ICONS: ChatActionIcons = {
  reply: Reply,
  copy: Copy,
  edit: Pencil,
  trash2: Trash2,
};

/**
 * Menu d'appui long. La construction est pure (`chat-actions.ts`) ; le hook ne
 * fait que memoïser sur des dépendances stables.
 */
export function useChatActions(input: ChatActionsInput): SheetAction[] {
  const {
    message,
    capabilities,
    onReply,
    onCopy,
    onEdit,
    onDelete,
    extra,
  } = input;
  return useMemo(
    () =>
      buildChatActions({
        message,
        capabilities,
        icons: ACTION_ICONS,
        onReply,
        onCopy,
        onEdit,
        onDelete,
        extra,
      }),
    [message, capabilities, onReply, onCopy, onEdit, onDelete, extra],
  );
}
