import { Copy, Reply, Trash, Trash2 } from 'lucide-react-native';
import { useMemo } from 'react';

import type { SheetAction } from '@/components/action-sheet';
import { fr } from '@/i18n/fr';
import type { ChatCapabilities, ChatMessageView } from '../transport/types';

/**
 * Actions du menu d'appui long, filtrées **uniquement** par `capabilities`.
 * Les actions propres à un mode (favori sticker, transfert chiffré, infos)
 * sont ajoutées par l'écran via `extra`.
 */
export function useChatActions(input: {
  message: ChatMessageView | null;
  capabilities: ChatCapabilities;
  onReply: (message: ChatMessageView) => void;
  onCopy: (message: ChatMessageView) => void;
  onDeleteForMe: (message: ChatMessageView) => void;
  onDeleteForAll: (message: ChatMessageView) => void;
  extra?: SheetAction[];
}): SheetAction[] {
  const { message, capabilities, onReply, onCopy, onDeleteForMe, onDeleteForAll, extra } = input;
  return useMemo(() => {
    if (!message) return [];
    const waiting = message.state === 'pending' || message.state === 'failed';
    const actions: SheetAction[] = [...(extra ?? [])];
    if (capabilities.replies && !waiting && !message.deleted) {
      actions.push({
        key: 'reply',
        label: fr.chat.menu.reply,
        icon: Reply,
        onPress: () => onReply(message),
      });
    }
    if (message.body) {
      actions.push({
        key: 'copy',
        label: fr.chat.menu.copy,
        icon: Copy,
        onPress: () => onCopy(message),
      });
    }
    actions.push({
      key: 'delete-me',
      label: waiting ? fr.chat.menu.delete : fr.chat.menu.deleteForMe,
      icon: Trash2,
      destructive: true,
      onPress: () => onDeleteForMe(message),
    });
    if (
      capabilities.deleteForEveryone &&
      !waiting &&
      !message.deleted &&
      message.mine
    ) {
      actions.push({
        key: 'delete-all',
        label: fr.chat.menu.deleteForAll,
        icon: Trash,
        destructive: true,
        onPress: () => onDeleteForAll(message),
      });
    }
    return actions;
  }, [message, capabilities, onReply, onCopy, onDeleteForMe, onDeleteForAll, extra]);
}
