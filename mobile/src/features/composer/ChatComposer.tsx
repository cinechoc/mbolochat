import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  BackHandler,
  Keyboard,
  KeyboardEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  type TextInputSelectionChangeEvent,
  View,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Svg, { Line, Path } from 'react-native-svg';
import { EmojiStickerPanel, type PanelTheme } from '../emoji/EmojiStickerPanel';
import type { RecentGif } from '../media/GifPanel';
import type { PersonalSticker } from '../stickers/stickerLibrary';
import { useEmojiFavorites } from '../emoji/useEmojiFavorites';
import { useRecentEmoji } from '../emoji/useRecentEmoji';
import { deleteBackward, insertAt } from '../emoji/emojiUtils';
import { useVoiceRecorder, type VoiceNote } from '../voice-notes/useVoiceRecorder';
import { RecordingTimeline } from './RecordingTimeline';

export type ComposerTheme = PanelTheme & {
  barBg: string;
  inputBg: string;
  inputText: string;
  placeholder: string;
  /** Fond du bouton d'envoi (bleu de marque). */
  sendBg: string;
};

/** Valeurs WeChat (thème clair). Associe-les au thème existant du projet (clair ET sombre). */
export const DEFAULT_COMPOSER_THEME: ComposerTheme = {
  barBg: '#F7F7F7',
  inputBg: '#FFFFFF',
  inputText: '#111111',
  placeholder: '#9B9B9B',
  sendBg: '#3C87F7',
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
  /** Sticker personnel : l'image locale est importée puis envoyée comme sticker. */
  onSendPersonalSticker: (sticker: PersonalSticker) => void;
  /** GIF déjà présents dans la conversation, réutilisables dans l'onglet GIF. */
  recentGifs: RecentGif[];
  onSendGif: (gif: RecentGif) => void;
  /** Note vocale enregistrée (appui long sur l'onde, relâchement = envoi). */
  onSendVoice: (note: VoiceNote) => void;
  onVoicePermissionDenied?: () => void;
  onVoiceError?: (error: unknown) => void;
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
  /** Brouillon restauré à l'ouverture de la conversation. */
  initialText?: string;
  /** Membres proposés après « @ » (groupes uniquement). */
  mentionCandidates?: { id: string; username: string; displayName: string }[];
};

const DEFAULT_PANEL_HEIGHT = 290;
const MIN_PANEL_HEIGHT = 240;
/** Le panneau se réduit quand le clavier de recherche est ouvert, pour laisser voir la conversation. */
const SEARCH_PANEL_HEIGHT = 220;
/** La barre d'onglets principale prend 48 px : la recherche garde une grille lisible. */
const SEARCH_PANEL_MIN_HEIGHT = 176;
const COMPOSER_BAR_HEIGHT = 56;
const SEARCH_CONVERSATION_RESERVE = 24;
let lastKeyboardHeight = 0; // gardée entre les conversations : le panneau a la même hauteur que le clavier

type Selection = { start: number; end: number };


export function ChatComposer({
  onSendText,
  onSendSticker,
  onSendPersonalSticker,
  recentGifs,
  onSendGif,
  onSendVoice,
  onVoicePermissionDenied,
  onVoiceError,
  plusPanel,
  onTextChange,
  bottomInset = 0,
  availableHeight,
  placeholder = 'Écrire un message…',
  disabled,
  theme: themeOverride,
  initialText = '',
  mentionCandidates,
}: Props) {
  const t: ComposerTheme = { ...DEFAULT_COMPOSER_THEME, ...themeOverride };
  const { recents, push } = useRecentEmoji();
  const { favorites, toggle: toggleFavorite } = useEmojiFavorites();

  const [text, setText] = useState(initialText);
  const [panel, setPanel] = useState<Panel>('none');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const [forcedSelection, setForcedSelection] = useState<Selection | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const cancellingRef = useRef(false);
  const grantAtRef = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const inputRef = useRef<TextInputInstance>(null);
  const textRef = useRef(initialText);
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

  /** Membre proposé quand la saisie se termine par « @… ». */
  const mention = useMemo(() => {
    if (!mentionCandidates || mentionCandidates.length === 0) {
      return null;
    }
    const match = /(?:^|\s)@([\p{L}\p{N}._-]*)$/u.exec(text);
    if (!match) {
      return null;
    }
    const query = match[1].toLowerCase();
    const atIndex = text.length - match[1].length - 1;
    const items = mentionCandidates
      .filter(
        (candidate) =>
          candidate.username.toLowerCase().includes(query) ||
          candidate.displayName.toLowerCase().includes(query),
      )
      .slice(0, 6);
    return items.length > 0 ? { query, atIndex, items } : null;
  }, [text, mentionCandidates]);

  const pickMention = useCallback(
    (candidate: { id: string; username: string }) => {
      const info = mention;
      if (!info) return;
      const value = textRef.current;
      const insert = `@${candidate.username} `;
      const next = value.slice(0, info.atIndex) + insert;
      commit(next, next.length);
      inputRef.current?.focus();
    },
    [commit, mention],
  );

  // Stable et basée sur des refs : elle est rappelée en boucle pendant un appui long.
  const handleBackspace = useCallback(() => {    const { start, end } = selectionRef.current;
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

  /* ------------------------------ Enregistrement vocal ------------------------------ */

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 1400);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const { status, elapsedMs, levels, start, release } = useVoiceRecorder({
    onSend: onSendVoice,
    onPermissionDenied: onVoicePermissionDenied,
    onError: onVoiceError,
    onTooShort: () => showNotice('Message trop court'),
  });
  const recording = status === 'recording' || status === 'starting';
  const lockRequestedRef = useRef(false);

  // Fin d'enregistrement (envoi, annulation, limite 60 s) : on relâche le verrou.
  // Un tap court arme le verrou dès que la capture démarre réellement.
  useEffect(() => {
    if (recording && lockRequestedRef.current) {
      lockRequestedRef.current = false;
      setLocked(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    if (status === 'idle') {
      setLocked(false);
      lockRequestedRef.current = false;
    }
  }, [recording, status]);

  // Tap court = enregistrement verrouillé ; appui maintenu puis relâche = envoi.
  const TAP_MS = 400;
  const voicePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => false,
        onPanResponderGrant: () => {
          setPanel('none');
          setSearchActive(false);
          searchActiveRef.current = false;
          // Pas de Keyboard.dismiss() : le champ reste monté/focus et le
          // clavier ouvert pendant l'enregistrement (comportement WhatsApp).
          cancellingRef.current = false;
          setCancelling(false);
          grantAtRef.current = Date.now();
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          void start();
        },
        onPanResponderMove: (_event, gesture) => {
          const next = gesture.dy < -60;
          if (next !== cancellingRef.current) {
            cancellingRef.current = next;
            setCancelling(next);
            Haptics.selectionAsync().catch(() => {});
          }
        },
        onPanResponderRelease: () => {
          if (Date.now() - grantAtRef.current < TAP_MS && !cancellingRef.current) {
            lockRequestedRef.current = true;
            return;
          }
          release(cancellingRef.current);
          cancellingRef.current = false;
          setCancelling(false);
        },
        onPanResponderTerminate: () => {
          release(true);
          cancellingRef.current = false;
          setCancelling(false);
        },
      }),
    [disabled, start, release],
  );

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
      {mention ? (
        <View
          style={[styles.mentionPanel, { backgroundColor: t.panelBg, borderColor: t.border }]}>
          {mention.items.map((candidate) => (
            <Pressable
              key={candidate.id}
              onPress={() => pickMention(candidate)}
              accessibilityRole="button"
              accessibilityLabel={`Mentionner ${candidate.displayName}`}
              style={({ pressed }) => [
                styles.mentionRow,
                pressed && { backgroundColor: t.pressed },
              ]}>
              <Text style={[styles.mentionName, { color: t.text }]} numberOfLines={1}>
                @{candidate.username}
              </Text>
              <Text style={[styles.mentionDisplay, { color: t.subtle }]} numberOfLines={1}>
                {candidate.displayName}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={[styles.bar, { borderTopColor: t.border }]}>
        <View style={styles.center}>
          <View style={[styles.field, { backgroundColor: t.inputBg }]}>
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
              style={[styles.input, { color: t.inputText }]}
              textAlignVertical="center"
              blurOnSubmit={false}
            />
            {recording ? (
              <View
                pointerEvents="none"
                style={[styles.recordingOverlay, { backgroundColor: t.inputBg }]}
              >
                <RecordingTimeline
                  levels={levels}
                  elapsedMs={elapsedMs}
                  cancelling={cancelling}
                  colors={{
                    bar: t.sendBg,
                    cancel: '#FA5151',
                    text: t.inputText,
                    dot: t.sendBg,
                  }}
                />
              </View>
            ) : null}
            {locked ? (
              <FieldButton
                onPress={() => {
                  release(true);
                  setLocked(false);
                }}
                label="Annuler l'enregistrement"
              >
                <MaterialCommunityIcons name="close-circle-outline" size={24} color="#FA5151" />
              </FieldButton>
            ) : recording || text.length === 0 ? (
              <View
                {...voicePan.panHandlers}
                accessible
                accessibilityRole="button"
                accessibilityLabel="Appui long pour enregistrer, tap pour verrouiller"
                style={styles.fieldButton}
              >
                <WaveformIcon color={recording ? t.sendBg : t.icon} size={22} />
              </View>
            ) : (
              <FieldButton onPress={() => togglePanel('plus')} label="Plus d'actions">
                <MaterialCommunityIcons
                  name={panel === 'plus' ? 'close-circle-outline' : 'plus-circle-outline'}
                  size={24}
                  color={t.icon}
                />
              </FieldButton>
            )}
            {notice && !recording ? (
              <View style={[styles.noticeOverlay, { backgroundColor: t.inputBg }]}>
                <Text style={{ color: t.subtle, fontSize: 13 }}>{notice}</Text>
              </View>
            ) : null}
          </View>
        </View>

        {locked ? null : (
          <IconButton
            name={panel === 'emoji' ? 'keyboard-outline' : 'emoticon-happy-outline'}
            color={t.icon}
            label={panel === 'emoji' ? 'Clavier' : 'Emojis, stickers et GIF'}
            onPress={() => togglePanel('emoji')}
          />
        )}

        {locked ? (
          <SendButton
            background={t.sendBg}
            color={t.accentText}
            onPress={() => {
              release(false);
              setLocked(false);
            }}
          />
        ) : hasText ? (
          <SendButton background={t.sendBg} color={t.accentText} onPress={handleSend} />
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
            onSendSticker={onSendSticker}
            onSendPersonalSticker={onSendPersonalSticker}
            gifItems={recentGifs}
            onSendGif={onSendGif}
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
  /** Icône dessinée sur mesure ; remplace l'icône MaterialCommunityIcons. */
  children?: React.ReactNode;
};

function IconButton({ name, color, label, onPress, children }: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.iconButton, pressed && { opacity: 0.55 }]}
    >
      {children ?? <MaterialCommunityIcons name={name} size={26} color={color} />}
    </Pressable>
  );
}

type FieldButtonProps = { label: string; onPress: () => void; children: React.ReactNode };

/** Icône intégrée au champ de saisie (bascule vocal / clavier). */
function FieldButton({ label, onPress, children }: FieldButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.fieldButton, pressed && { opacity: 0.55 }]}
    >
      {children}
    </Pressable>
  );
}

type SendButtonProps = { background: string; color: string; onPress: () => void };

/** Bouton d'envoi : pastille, avion en papier SVG, apparition élastique. */
function SendButton({ background, color, onPress }: SendButtonProps) {
  const scale = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    Animated.spring(scale, { toValue: 1, friction: 6, tension: 140, useNativeDriver: true }).start();
  }, [scale]);
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Envoyer"
        style={({ pressed }) => [
          styles.send,
          { backgroundColor: background, shadowColor: background },
          pressed && styles.sendPressed,
        ]}
      >
        <Svg width={20} height={20} viewBox="0 0 24 24">
          <Path
            d="M2.4 20.4 21.6 12 2.4 3.6l.1 5.8L14 12 2.5 14.6z"
            fill={color}
            stroke={color}
            strokeWidth={1.2}
            strokeLinejoin="round"
          />
        </Svg>
      </Pressable>
    </Animated.View>
  );
}

/** Onde vocale : 5 barres arrondies, centre plus haut. */
function WaveformIcon({ color, size = 26 }: { color: string; size?: number }) {
  const weights = [0.36, 0.68, 1, 0.68, 0.36];
  const stroke = 3;
  const gap = (size - stroke * weights.length) / (weights.length - 1);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {weights.map((weight, index) => {
        const h = size * weight;
        const x = index * (stroke + gap) + stroke / 2;
        return (
          <Line
            key={index}
            x1={x}
            y1={(size - h) / 2}
            x2={x}
            y2={(size + h) / 2}
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        );
      })}
    </Svg>
  );
}

const styles = StyleSheet.create({
  mentionPanel: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: '100%',
    marginBottom: 4,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    elevation: 8,
    zIndex: 20,
  },
  mentionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  mentionName: { fontWeight: '600' },
  mentionDisplay: { flexShrink: 1, fontSize: 13 },
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 6,
    paddingVertical: 8,
    gap: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  center: { flex: 1, justifyContent: 'flex-end' },
  field: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 40,
    borderRadius: 6,
    paddingRight: 2,
  },
  noticeOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: 6,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 10,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: 16,
  },
  fieldButton: { width: 32, height: 40, alignItems: 'center', justifyContent: 'center', marginRight: 2 },
  recordingOverlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    right: 34,
    borderRadius: 6,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  iconButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  sendPressed: { transform: [{ scale: 0.92 }], opacity: 0.92 },
});
