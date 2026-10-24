import { Ionicons } from '@expo/vector-icons';
import { memo, type ReactNode, type RefObject } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputInstance,
  type TextInputSelectionChangeEvent,
} from 'react-native';

import { useChatColors } from '@/constants/chat-theme';
import { Spacing } from '@/constants/theme';

export interface ComposerSelection {
  start: number;
  end: number;
}

export type ComposerExpressionTab = 'stickers' | 'emoji' | 'gif';

interface MessageComposerProps {
  inputRef?: RefObject<TextInputInstance | null>;
  value: string;
  onChangeText: (value: string) => void;
  onSelectionChange: (event: TextInputSelectionChangeEvent) => void;
  /** Sélection forcée une fois, après une insertion d'émoji. */
  selection?: ComposerSelection;
  mode: 'keyboard' | 'voice';
  onToggleMode: () => void;
  /** Enregistreur vocal : le parent garde la main sur le micro et ses permissions. */
  voiceRecorder: ReactNode;
  expressionOpen: boolean;
  expressionTab?: ComposerExpressionTab;
  keyboardVisible: boolean;
  onToggleExpression: () => void;
  attachOpen: boolean;
  onToggleAttach: () => void;
  onSend: () => void;
  onFocus: () => void;
  onBlur?: () => void;
  bottomInset: number;
  /** Clavier ou panneau ouvert : le bas est déjà occupé. */
  compactBottom: boolean;
  placeholder?: string;
}

/**
 * Barre de saisie de la conversation.
 *
 * Champ vide : micro à gauche, « + » à droite. Dès qu'il y a du texte, le « + »
 * passe à gauche (pièces jointes toujours accessibles) et l'envoi le remplace à
 * droite. Le champ et le bouton d'expression restent au même endroit.
 */
export const MessageComposer = memo(function MessageComposer({
  inputRef,
  value,
  onChangeText,
  onSelectionChange,
  selection,
  mode,
  onToggleMode,
  voiceRecorder,
  expressionOpen,
  expressionTab = 'stickers',
  keyboardVisible,
  onToggleExpression,
  attachOpen,
  onToggleAttach,
  onSend,
  onFocus,
  onBlur,
  bottomInset,
  compactBottom,
  placeholder = 'Écrire un message…',
}: MessageComposerProps) {
  const chat = useChatColors();
  const hasText = value.trim().length > 0;
  // Le panneau Émojis remplace le clavier ; sur Stickers/GIF, le bouton
  // ramène d'abord sur l'onglet Émojis.
  const showKeyboardIcon =
    expressionOpen && expressionTab === 'emoji' && !keyboardVisible;

  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: chat.composer,
          borderTopColor: chat.border,
          paddingBottom: compactBottom ? Spacing.two : Math.max(bottomInset, Spacing.two),
        },
      ]}>
      {mode === 'voice' ? (
        <>
          <Pressable
            onPress={onToggleMode}
            hitSlop={6}
            style={({ pressed }) => [
              styles.circleButton,
              { backgroundColor: chat.input },
              pressed && styles.pressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Revenir au clavier">
            <Ionicons name="keypad-outline" size={23} color={chat.primaryText} />
          </Pressable>
          <View style={styles.voiceSlot}>{voiceRecorder}</View>
        </>
      ) : (
        <>
          {hasText ? (
            <Pressable
              onPress={onToggleAttach}
              hitSlop={6}
              style={({ pressed }) => [
                styles.circleButton,
                { backgroundColor: chat.input },
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityState={{ expanded: attachOpen }}
              accessibilityLabel={
                attachOpen ? 'Fermer les pièces jointes' : 'Ouvrir les pièces jointes'
              }>
              <Ionicons
                name={attachOpen ? 'close' : 'add'}
                size={26}
                color={chat.primaryText}
              />
            </Pressable>
          ) : (
            <Pressable
              onPress={onToggleMode}
              hitSlop={6}
              style={({ pressed }) => [
                styles.circleButton,
                { backgroundColor: chat.input },
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Passer au mode vocal">
              <Ionicons name="mic-outline" size={23} color={chat.primaryText} />
            </Pressable>
          )}

          <View style={[styles.field, { backgroundColor: chat.input, borderColor: chat.border }]}>
            <TextInput
              ref={inputRef}
              style={[styles.input, { color: chat.primaryText }]}
              placeholder={placeholder}
              placeholderTextColor={chat.inputPlaceholder}
              value={value}
              multiline
              onChangeText={onChangeText}
              onSelectionChange={onSelectionChange}
              selection={selection}
              onFocus={onFocus}
              onPressIn={onFocus}
              onBlur={onBlur}
              onSubmitEditing={onSend}
              blurOnSubmit={false}
              scrollEnabled
              accessibilityLabel="Message"
            />
            <Pressable
              onPress={onToggleExpression}
              hitSlop={4}
              style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityState={{ expanded: expressionOpen }}
              accessibilityLabel={
                showKeyboardIcon
                  ? 'Revenir au clavier'
                  : 'Ouvrir les émojis'
              }>
              <Ionicons
                name={showKeyboardIcon ? 'keypad-outline' : 'happy-outline'}
                size={24}
                color={showKeyboardIcon ? chat.primaryText : chat.secondaryText}
              />
            </Pressable>
          </View>

          {hasText ? (
            <Pressable
              onPress={onSend}
              style={({ pressed }) => [
                styles.circleButton,
                { backgroundColor: chat.send },
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Envoyer le message">
              <Ionicons name="arrow-up" size={23} color={chat.sendText} />
            </Pressable>
          ) : (
            <Pressable
              onPress={onToggleAttach}
              hitSlop={6}
              style={({ pressed }) => [
                styles.circleButton,
                { backgroundColor: chat.input },
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityState={{ expanded: attachOpen }}
              accessibilityLabel={attachOpen ? 'Fermer les pièces jointes' : 'Ouvrir les pièces jointes'}>
              <Ionicons name={attachOpen ? 'close' : 'add'} size={26} color={chat.primaryText} />
            </Pressable>
          )}
        </>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.one,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  circleButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: {
    flex: 1,
    minHeight: 42,
    maxHeight: 118,
    borderRadius: 21,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: 14,
    paddingRight: 2,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 108,
    fontSize: 16,
    lineHeight: 21,
    paddingTop: 10,
    paddingBottom: 10,
    paddingRight: 4,
  },
  inlineButton: {
    width: 38,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceSlot: {
    flex: 1,
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.62,
  },
});
