import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Keyboard,
  KeyboardEvent,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  type TextInputSelectionChangeEvent,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { EmojiStickerPanel, type PanelTheme } from '../emoji/EmojiStickerPanel';
import { useEmojiFavorites } from '../emoji/useEmojiFavorites';
import { useRecentEmoji } from '../emoji/useRecentEmoji';
import { deleteBackward, insertAt } from '../emoji/emojiUtils';

export type ComposerTheme = PanelTheme & {
  barBg: string;
  inputBg: string;
  inputText: string;
  placeholder: string;
};

/** Valeurs WeChat (thème clair). Associe-les au thème existant du projet (clair ET sombre). */
export const DEFAULT_COMPOSER_THEME: ComposerTheme = {
  barBg: '#F7F7F7',
  inputBg: '#FFFFFF',
  inputText: '#111111',
  placeholder: '#9B9B9B',
  panelBg: '#EDEDED',
  tabBg: '#E3E3E3',
  tabActiveBg: '#FFFFFF',
  text: '#111111',
  subtle: '#9B9B9B',
  icon: '#181818',
  border: '#DCDCDC',
  pressed: '#DADADA',
  accent: '#07C160',
  accentText: '#FFFFFF',
};

type Panel = 'none' | 'emoji' | 'plus';

type Props = {
  onSendText: (text: string) => void;
  /** Référence « pack/sticker » à envoyer comme message sticker. */
  onSendSticker: (ref: string) => void;
  /** Le bouton « Maintenir pour parler » existant (VoiceRecordButton), affiché à la place du champ en mode voix. */
  voiceSlot: React.ReactNode;
  /** Contenu du panneau « + » existant (Photos/Vidéos, Appareil photo, Fichier…). */
  plusPanel: React.ReactNode;
  /** Pour l'indicateur « en train d'écrire » éventuel. */
  onTextChange?: (text: string) => void;
  /** Marge de sécurité en bas (ex. insets.bottom) appliquée quand ni clavier ni panneau ne sont ouverts. */
  bottomInset?: number;
  /** Hauteur disponible au-dessus du clavier, mesurée par l'écran de conversation. */
  availableHeight?: number;
  placeholder?: string;
  disabled?: boolean;
  theme?: Partial<ComposerTheme>;
};

const DEFAULT_PANEL_HEIGHT = 290;
const MIN_PANEL_HEIGHT = 240;
/** Le panneau se réduit quand le clavier de recherche est ouvert, pour laisser voir la conversation. */
const SEARCH_PANEL_HEIGHT = 220;
const SEARCH_PANEL_MIN_HEIGHT = 120;
const COMPOSER_BAR_HEIGHT = 56;
const SEARCH_CONVERSATION_RESERVE = 24;
let lastKeyboardHeight = 0; // gardée entre les conversations : le panneau a la même hauteur que le clavier

type Selection = { start: number; end: number };

export function ChatComposer({
  onSendText,
  onSendSticker,
  voiceSlot,
  plusPanel,
  onTextChange,
  bottomInset = 0,
  availableHeight,
  placeholder = 'Écrire un message…',
  disabled,
  theme: themeOverride,
}: Props) {
  const t: ComposerTheme = { ...DEFAULT_COMPOSER_THEME, ...themeOverride };
  const { recents, push } = useRecentEmoji();
  const { favorites, toggle: toggleFavorite } = useEmojiFavorites();

  const [text, setText] = useState('');
  const [voice, setVoice] = useState(false);
  const [panel, setPanel] = useState<Panel>('none');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [forcedSelection, setForcedSelection] = useState<Selection | null>(null);

  const inputRef = useRef<TextInputInstance>(null);
  const textRef = useRef('');
  const selectionRef = useRef<Selection>({ start: 0, end: 0 });
  /** Le clavier visible appartient à la recherche du panneau, pas au champ. */
  const searchActiveRef = useRef(false);

  /* ------------------------ Clavier et bouton retour ------------------------ */

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e: KeyboardEvent) => {
      lastKeyboardHeight = Math.round(e.endCoordinates.height);
      setKeyboardVisible(true);
      // Le clavier de la recherche vit dans le panneau : il ne doit pas le fermer.
      if (!searchActiveRef.current) {
        setPanel('none'); // l'utilisateur tape dans le champ : le clavier prend la place du panneau
      }
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    if (panel === 'none') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setPanel('none');
      setSearchActive(false);
      searchActiveRef.current = false;
      Keyboard.dismiss();
      return true;
    });
    return () => sub.remove();
  }, [panel]);

  const handleSearchFocusChange = useCallback((focused: boolean) => {
    searchActiveRef.current = focused;
    setSearchActive(focused);
  }, []);

  /* ------------------------------ Édition du texte ------------------------------ */

  const commit = useCallback(
    (next: string, cursor?: number) => {
      textRef.current = next;
      setText(next);
      onTextChange?.(next);
      if (cursor !== undefined) {
        selectionRef.current = { start: cursor, end: cursor };
        setForcedSelection({ start: cursor, end: cursor });
      }
    },
    [onTextChange],
  );

  const handlePickEmoji = useCallback(
    (emoji: string) => {
      const { start, end } = selectionRef.current;
      const result = insertAt(textRef.current, start, end, emoji);
      commit(result.text, result.cursor);
      push(emoji);
    },
    [commit, push],
  );

  // Stable et basée sur des refs : elle est rappelée en boucle pendant un appui long.
  const handleBackspace = useCallback(() => {
    const { start, end } = selectionRef.current;
    const result = deleteBackward(textRef.current, start, end);
    commit(result.text, result.cursor);
  }, [commit]);

  const handleSend = useCallback(() => {
    const value = textRef.current.trim();
    if (!value) return;
    onSendText(value);
    commit('', 0);
  }, [commit, onSendText]);

  const handleSelectionChange = useCallback(
    (e: TextInputSelectionChangeEvent) => {
      selectionRef.current = e.nativeEvent.selection;
      // La sélection « forcée » ne sert qu'une fois, puis le champ redevient libre.
      setForcedSelection((current) => (current ? null : current));
    },
    [],
  );

  /* ------------------------------ Bascules ------------------------------ */

  const toggleVoice = () => {
    setSearchActive(false);
    searchActiveRef.current = false;
    if (voice) {
      setVoice(false);
      setPanel('none');
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setVoice(true);
      setPanel('none');
      Keyboard.dismiss();
    }
  };

  const togglePanel = (target: 'emoji' | 'plus') => {
    if (panel === target) {
      // Rendre le clavier au compositeur avant de démonter le panneau de recherche.
      if (target === 'emoji') inputRef.current?.focus();
      setPanel('none');
      setSearchActive(false);
      searchActiveRef.current = false;
      if (target === 'emoji') requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    setVoice(false);
    setSearchActive(false);
    searchActiveRef.current = false;
    setPanel(target); // d'abord le panneau, ensuite on ferme le clavier : pas de saut
    Keyboard.dismiss();
  };

  /* ------------------------------ Rendu ------------------------------ */

  const hasText = text.trim().length > 0;
  const panelHeight = Math.max(MIN_PANEL_HEIGHT, lastKeyboardHeight || DEFAULT_PANEL_HEIGHT);
  const searchMaxHeight =
    availableHeight && availableHeight > 0
      ? availableHeight - COMPOSER_BAR_HEIGHT - SEARCH_CONVERSATION_RESERVE
      : SEARCH_PANEL_HEIGHT;
  const searchPanelHeight = Math.max(
    SEARCH_PANEL_MIN_HEIGHT,
    Math.min(SEARCH_PANEL_HEIGHT, searchMaxHeight),
  );
  const emojiPanelHeight = searchActive ? searchPanelHeight : panelHeight;
  const showBottomInset = panel === 'none' && !keyboardVisible;

  return (
    <View style={{ backgroundColor: t.barBg }}>
      <View style={[styles.bar, { borderTopColor: t.border }]}>
        <IconButton
          name={voice ? 'keyboard-outline' : 'microphone-outline'}
          color={t.icon}
          label={voice ? 'Clavier' : 'Message vocal'}
          onPress={toggleVoice}
        />

        <View style={styles.center}>
          {voice ? (
            voiceSlot
          ) : (
            <TextInput
              ref={inputRef}
              value={text}
              editable={!disabled}
              multiline
              placeholder={placeholder}
              placeholderTextColor={t.placeholder}
              onChangeText={(value) => commit(value)}
              selection={forcedSelection ?? undefined}
              onSelectionChange={handleSelectionChange}
              onFocus={() => {
                if (panel !== 'none') {
                  setPanel('none');
                  setSearchActive(false);
                  searchActiveRef.current = false;
                }
              }}
              style={[styles.input, { backgroundColor: t.inputBg, color: t.inputText }]}
              textAlignVertical="center"
              blurOnSubmit={false}
            />
          )}
        </View>

        <IconButton
          name={panel === 'emoji' ? 'keyboard-outline' : 'emoticon-happy-outline'}
          color={t.icon}
          label={panel === 'emoji' ? 'Clavier' : 'Emoji et stickers'}
          onPress={() => togglePanel('emoji')}
        />

        {hasText && !voice ? (
          <Pressable
            onPress={handleSend}
            accessibilityRole="button"
            accessibilityLabel="Envoyer"
            style={[styles.send, { backgroundColor: t.accent }]}
          >
            <Text style={{ color: t.accentText, fontWeight: '600', fontSize: 15 }}>Envoyer</Text>
          </Pressable>
        ) : (
          <IconButton
            name={panel === 'plus' ? 'close-circle-outline' : 'plus-circle-outline'}
            color={t.icon}
            label="Plus d'actions"
            onPress={() => togglePanel('plus')}
          />
        )}
      </View>

      {panel === 'emoji' && (
        <View style={{ height: emojiPanelHeight + bottomInset, backgroundColor: t.panelBg }}>
          <EmojiStickerPanel
            height={emojiPanelHeight}
            recents={recents}
            favorites={favorites}
            onPickEmoji={handlePickEmoji}
            onBackspace={handleBackspace}
            onPickSticker={onSendSticker}
            showSend={hasText}
            onSend={handleSend}
            theme={t}
            onToggleFavorite={toggleFavorite}
            onSearchFocusChange={handleSearchFocusChange}
          />
        </View>
      )}

      {panel === 'plus' && (
        <View style={{ height: panelHeight + bottomInset, backgroundColor: t.panelBg }}>{plusPanel}</View>
      )}

      {showBottomInset ? <View style={{ height: bottomInset }} /> : null}
    </View>
  );
}

type IconButtonProps = {
  name: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  color: string;
  label: string;
  onPress: () => void;
};

function IconButton({ name, color, label, onPress }: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.iconButton, pressed && { opacity: 0.55 }]}
    >
      <MaterialCommunityIcons name={name} size={30} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 6,
    paddingVertical: 8,
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  center: { flex: 1, justifyContent: 'flex-end' },
  input: {
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: 16,
  },
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  send: { height: 36, paddingHorizontal: 14, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
});
