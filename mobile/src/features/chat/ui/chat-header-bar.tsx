import type { ComponentRef, ReactNode, RefObject } from 'react';
import type { View } from 'react-native';

import { ChatHeaderScreen } from '@/features/chat/ui/chat-header';
import { fr } from '@/i18n/fr';
import type { ChatMode } from '../transport/types';

/**
 * En-tête unifié. La mention de sécurité est toujours visible dans le
 * sous-titre, y compris quand le pair est en train d'écrire.
 */
export function ChatHeaderBar({
  title,
  subtitle,
  mode,
  presenceUserId,
  onPressTitle,
  titleAccessibilityLabel,
  right,
  blurTarget,
}: {
  title: string;
  subtitle: string;
  mode: ChatMode | 'blocked';
  presenceUserId?: string;
  onPressTitle?: () => void;
  titleAccessibilityLabel?: string;
  right?: ReactNode;
  blurTarget?: RefObject<ComponentRef<typeof View> | null>;
}) {
  const security =
    mode === 'e2ee'
      ? fr.chat.unified.securityEncrypted
      : mode === 'blocked'
        ? fr.chat.unified.securityBlocked
        : fr.chat.unified.securityPlaintext;
  return (
    <ChatHeaderScreen
      title={title}
      subtitle={subtitle ? `${subtitle} · ${security}` : security}
      presenceUserId={presenceUserId}
      onPressTitle={onPressTitle}
      titleAccessibilityLabel={
        titleAccessibilityLabel ?? (onPressTitle ? `${title} — ${security}` : undefined)
      }
      right={right}
      blurTarget={blurTarget}
    />
  );
}
