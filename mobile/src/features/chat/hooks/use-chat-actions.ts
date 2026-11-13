import { Copy, Reply, Trash, Trash2 } from 'lucide-react-native';
import { useMemo } from 'react';

import type { SheetAction } from '@/components/action-sheet';
import { buildChatActions, type ChatActionIcons, type ChatActionsInput } from '../model/chat-actions';

const ACTION_ICONS: ChatActionIcons = {
  reply: Reply,
  copy: Copy,
  trash: Trash,
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
    onDeleteForMe,
    onDeleteForAll,
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
        onDeleteForMe,
        onDeleteForAll,
        extra,
      }),
    [message, capabilities, onReply, onCopy, onDeleteForMe, onDeleteForAll, extra],
  );
}
