import { X } from 'lucide-react-native';
import { useCallback, useRef, useState, type ComponentRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AttachPanel } from '@/components/attach-panel';
import { ThemedText } from '@/components/themed-text';
import { ChatComposer, type ComposerTheme } from '@/features/composer/ChatComposer';
import { ChatReplyBar } from '@/features/chat/ui/chat-reply-bar';
import type { RecentGif } from '@/features/media/GifPanel';
import type { PersonalSticker } from '@/features/stickers/stickerLibrary';
import type { VoiceNote } from '@/features/voice-notes/useVoiceRecorder';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { fr } from '@/i18n/fr';
import type { MessageQuote } from '@/lib/types';
import { useChatDraft } from '../hooks/use-chat-draft';
import type { ChatCapabilities, ChatTransport } from '../transport/types';

export interface ChatInputBarProps {
  transport: ChatTransport;
  capabilities: ChatCapabilities;
  composerTheme: Partial<ComposerTheme>;
  blurTarget?: React.RefObject<ComponentRef<typeof View> | null>;
  replyTo: MessageQuote | null;
  onCancelReply: () => void;
  editingId?: string | null;
  editingText?: string | null;
  onCancelEdit?: () => void;
  blockedText: string | null;
  bottomInset: number;
  availableHeight?: number;
  mentionCandidates?: { id: string; username: string; displayName: string }[];
  recentGifs: RecentGif[];
  onSendText: (text: string) => void | Promise<void>;
  onSendSticker: (ref: string) => void;
  onSendPersonalSticker: (sticker: PersonalSticker) => void;
  onSendGif: (gif: RecentGif) => void;
  onSendVoice: (note: VoiceNote) => void;
  onPickPhotos: () => void;
  onPickCamera: () => void;
  onPickDocuments: () => void;
  onVoicePermissionDenied: () => void;
  onVoiceError: (error: unknown) => void;
}

/**
 * Barre de saisie propriétaire de son texte : l'écran ne reçoit pas d'état à
 * chaque frappe. Le brouillon est écrit par le transport (SQLCipher en mode
 * chiffré, cache local sinon).
 */
export function ChatInputBar({
  transport,
  capabilities,
  composerTheme,
  blurTarget,
  replyTo,
  onCancelReply,
  editingId = null,
  editingText = null,
  onCancelEdit,
  blockedText,
  bottomInset,
  availableHeight,
  mentionCandidates,
  recentGifs,
  onSendText,
  onSendSticker,
  onSendPersonalSticker,
  onSendGif,
  onSendVoice,
  onPickPhotos,
  onPickCamera,
  onPickDocuments,
  onVoicePermissionDenied,
  onVoiceError,
}: ChatInputBarProps) {
  const theme = useTheme();
  const { text: draft, setText, reset } = useChatDraft({ transport });
  const [composerKey, setComposerKey] = useState(0);
  const editing = editingText !== null;
  const textRef = useRef(draft);
  const lastTypingRef = useRef(0);

  const remount = useCallback(() => {
    reset();
    textRef.current = '';
    setComposerKey((key) => key + 1);
  }, [reset]);

  const onChangeText = useCallback(
    (value: string) => {
      textRef.current = value;
      if (!editing) setText(value);
      if (!capabilities.typing) return;
      const now = Date.now();
      if (now - lastTypingRef.current > 180) {
        lastTypingRef.current = now;
        transport.setTyping(value.length > 0, value);
      }
    },
    [capabilities.typing, editing, setText, transport],
  );

  if (blockedText) {
    return (
      <View style={[styles.blocked, { paddingBottom: Spacing.four + bottomInset }]}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.blockedText}>
          {blockedText}
        </ThemedText>
      </View>
    );
  }

  return (
    <>
      {editing ? (
        <View style={[styles.editBar, { backgroundColor: composerTheme.panelBg ?? theme.backgroundElement }]}> 
          <ThemedText type="small" numberOfLines={1} style={styles.editLabel}>
            {fr.chat.unified.editingMessage}
          </ThemedText>
          <Pressable
            onPress={onCancelEdit}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={fr.common.cancel}>
            <X size={20} color={theme.accent} />
          </Pressable>
        </View>
      ) : replyTo ? (
        <ChatReplyBar quote={replyTo} onCancel={onCancelReply} />
      ) : null}
      <ChatComposer
        key={`${composerKey}:${editingId ?? 'draft'}`}
        blurTarget={blurTarget}
        theme={composerTheme}
        initialText={editing ? editingText : draft}
        mentionCandidates={mentionCandidates}
        bottomInset={bottomInset}
        availableHeight={availableHeight}
        sections={capabilities.stickers || capabilities.gifs ? undefined : ['emoji']}
        onSendText={onSendText}
        onSendSticker={(ref) => {
          if (!capabilities.stickers) return;
          onSendSticker(ref);
          remount();
        }}
        onSendPersonalSticker={(sticker) => {
          if (!capabilities.stickers) return;
          onSendPersonalSticker(sticker);
          remount();
        }}
        recentGifs={capabilities.gifs ? recentGifs : []}
        onSendGif={(gif) => {
          if (!capabilities.gifs) return;
          onSendGif(gif);
          remount();
        }}
        onSendVoice={onSendVoice}
        onVoicePermissionDenied={onVoicePermissionDenied}
        onVoiceError={onVoiceError}
        onTextChange={onChangeText}
        plusPanel={
          <AttachPanel
            onPhotos={onPickPhotos}
            onCamera={onPickCamera}
            onDocuments={onPickDocuments}
          />
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  editBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  editLabel: { flex: 1 },
  blocked: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.four,
    alignItems: 'center',
  },
  blockedText: { textAlign: 'center' },
});
