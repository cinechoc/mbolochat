import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { EMOJI_BY_KEY, EMOJI_GROUPS, type EmojiGroup, type EmojiItem } from './emojiCatalog';
import { EmojiImage } from './EmojiText';
import { toEmojiKey } from './emojiUtils';
import { STICKER_PACKS, stickerRef, type StickerPack } from '../stickers/stickerPacks';
import { StickerView } from '../stickers/StickerView';

export type PanelTheme = {
  panelBg: string;
  tabBg: string;
  tabActiveBg: string;
  text: string;
  subtle: string;
  icon: string;
  border: string;
  pressed: string;
  accent: string;
  accentText: string;
};

const BAR_H = 48; // barre d'onglets en bas
const DOTS_H = 20; // points de pagination
const COLS = 8;
const CELL_H = 46;
const EMOJI_SIZE = 30;
const STICKER_COLS = 4;

type Tab =
  | { id: string; kind: 'recent' }
  | { id: string; kind: 'group'; group: EmojiGroup }
  | { id: string; kind: 'pack'; pack: StickerPack };

type Props = {
  /** Hauteur totale du panneau (hors marge basse de sécurité). */
  height: number;
  recents: string[];
  onPickEmoji: (emoji: string) => void;
  /** Doit lire le texte courant via des refs (appelée en boucle lors d'un appui long). */
  onBackspace: () => void;
  onPickSticker: (ref: string) => void;
  showSend: boolean;
  onSend: () => void;
  theme: PanelTheme;
};

/* ------------------------------ Pagination ------------------------------ */

type PagerProps<T> = {
  items: T[];
  perPage: number;
  width: number;
  height: number;
  theme: PanelTheme;
  renderPage: (pageItems: T[]) => React.ReactElement;
};

function Pager<T>({ items, perPage, width, height, theme, renderPage }: PagerProps<T>) {
  const pages = useMemo(() => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += perPage) out.push(items.slice(i, i + perPage));
    return out.length ? out : [[] as T[]];
  }, [items, perPage]);
  const [page, setPage] = useState(0);

  const onEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      setPage(Math.round(e.nativeEvent.contentOffset.x / width));
    },
    [width],
  );

  const listHeight = height - DOTS_H;
  return (
    <View style={{ height }}>
      <FlatList
        horizontal
        pagingEnabled
        data={pages}
        style={{ height: listHeight, flexGrow: 0 }}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => <View style={{ width, height: listHeight }}>{renderPage(item)}</View>}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onEnd}
        initialNumToRender={1}
        windowSize={3}
      />
      <View style={styles.dots}>
        {pages.length > 1 &&
          pages.map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                { backgroundColor: theme.text, opacity: i === page ? 0.75 : 0.25 },
              ]}
            />
          ))}
      </View>
    </View>
  );
}

/* ------------------------------ Emoji ------------------------------ */

type BackspaceProps = { onBackspace: () => void; width: number; theme: PanelTheme };

/** Touche « effacer » : un appui efface un caractère, un appui long répète. */
const BackspaceCell = memo(function BackspaceCell({ onBackspace, width, theme }: BackspaceProps) {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Effacer"
      onPress={onBackspace}
      delayLongPress={350}
      onLongPress={() => {
        stop();
        timer.current = setInterval(onBackspace, 70);
      }}
      onPressOut={stop}
      style={({ pressed }) => [
        styles.cell,
        { width, height: CELL_H },
        pressed && { backgroundColor: theme.pressed, borderRadius: 8 },
      ]}
    >
      <MaterialCommunityIcons name="backspace-outline" size={26} color={theme.icon} />
    </Pressable>
  );
});

type EmojiPageProps = {
  items: EmojiItem[];
  cellW: number;
  rows: number;
  onPick: (emoji: string) => void;
  onBackspace: () => void;
  theme: PanelTheme;
};

const EmojiPage = memo(function EmojiPage({ items, cellW, rows, onPick, onBackspace, theme }: EmojiPageProps) {
  return (
    <View style={{ height: rows * CELL_H }}>
      {Array.from({ length: rows }, (_, rowIndex) => {
        const rowItems = items.slice(rowIndex * COLS, (rowIndex + 1) * COLS);
        return (
          <View key={rowIndex} style={{ flexDirection: 'row', height: CELL_H }}>
            {rowItems.map((emoji) => (
              <Pressable
                key={emoji.key}
                onPress={() => onPick(emoji.char)}
                accessibilityLabel={emoji.name}
                style={({ pressed }) => [
                  styles.cell,
                  { width: `${100 / COLS}%`, height: CELL_H },
                  pressed && { backgroundColor: theme.pressed, borderRadius: 8 },
                ]}
              >
                <EmojiImage emojiKey={emoji.key} size={EMOJI_SIZE} />
              </Pressable>
            ))}
          </View>
        );
      })}
      {/* Comme WeChat : la dernière case de CHAQUE page est la touche « effacer ». */}
      <View
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: `${100 / COLS}%`,
        }}>
        <BackspaceCell onBackspace={onBackspace} width={cellW} theme={theme} />
      </View>
    </View>
  );
});

/* ------------------------------ Panneau ------------------------------ */

export function EmojiStickerPanel({
  height,
  recents,
  onPickEmoji,
  onBackspace,
  onPickSticker,
  showSend,
  onSend,
  theme,
}: Props) {
  const { width } = useWindowDimensions();

  const tabs = useMemo<Tab[]>(
    () => [
      { id: 'recent', kind: 'recent' },
      ...EMOJI_GROUPS.map((group) => ({ id: group.id, kind: 'group' as const, group })),
      ...STICKER_PACKS.map((pack) => ({ id: `pack:${pack.id}`, kind: 'pack' as const, pack })),
    ],
    [],
  );

  const [tabId, setTabId] = useState<string>(() => (recents.length ? 'recent' : EMOJI_GROUPS[0]?.id ?? 'recent'));
  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0];

  const mainHeight = Math.max(120, height - BAR_H);
  const gridHeight = mainHeight - DOTS_H;
  const rows = Math.max(2, Math.floor(gridHeight / CELL_H));
  const emojiPerPage = COLS * rows - 1; // -1 : la case « effacer »
  const cellW = width / COLS;

  const recentItems = useMemo(
    () => recents.map((char) => EMOJI_BY_KEY.get(toEmojiKey(char))).filter((e): e is EmojiItem => !!e),
    [recents],
  );

  let content: React.ReactElement;
  if (tab.kind === 'pack') {
    const stickerCell = width / STICKER_COLS;
    const stickerRows = Math.max(1, Math.floor(gridHeight / stickerCell));
    content = (
      <Pager
        key={tab.id}
        items={tab.pack.stickers}
        perPage={STICKER_COLS * stickerRows}
        width={width}
        height={mainHeight}
        theme={theme}
        renderPage={(page) => (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {page.map((sticker) => (
              <Pressable
                key={sticker.id}
                onPress={() => onPickSticker(stickerRef(tab.pack.id, sticker.id))}
                style={({ pressed }) => [
                  styles.cell,
                  { width: `${100 / STICKER_COLS}%`, height: stickerCell },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <StickerView sticker={sticker} size={Math.round(stickerCell - 20)} />
              </Pressable>
            ))}
          </View>
        )}
      />
    );
  } else {
    const items = tab.kind === 'recent' ? recentItems : tab.group.emojis;
    content =
      tab.kind === 'recent' && items.length === 0 ? (
        <View style={[styles.empty, { height: mainHeight }]}>
          <Text style={{ color: theme.subtle }}>Aucun emoji récent</Text>
        </View>
      ) : (
        <Pager
          key={tab.id}
          items={items}
          perPage={emojiPerPage}
          width={width}
          height={mainHeight}
          theme={theme}
          renderPage={(page) => (
            <EmojiPage items={page} cellW={cellW} rows={rows} onPick={onPickEmoji} onBackspace={onBackspace} theme={theme} />
          )}
        />
      );
  }

  return (
    <View style={{ height, backgroundColor: theme.panelBg }}>
      {content}
      <View style={[styles.bar, { height: BAR_H, borderTopColor: theme.border, backgroundColor: theme.panelBg }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
          {tabs.map((t) => {
            const active = t.id === tab.id;
            return (
              <Pressable
                key={t.id}
                onPress={() => setTabId(t.id)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={[styles.tab, { backgroundColor: active ? theme.tabActiveBg : 'transparent' }]}
              >
                {t.kind === 'recent' ? (
                  <MaterialCommunityIcons name="clock-outline" size={24} color={theme.icon} />
                ) : t.kind === 'group' ? (
                  <EmojiImage emojiKey={t.group.iconKey} size={24} />
                ) : (
                  <EmojiImage emojiKey={toEmojiKey(t.pack.iconEmoji)} size={24} />
                )}
              </Pressable>
            );
          })}
        </ScrollView>
        {showSend && (
          <Pressable onPress={onSend} style={[styles.send, { backgroundColor: theme.accent }]}>
            <Text style={{ color: theme.accentText, fontWeight: '600', fontSize: 15 }}>Envoyer</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cell: { alignItems: 'center', justifyContent: 'center' },
  dots: { height: DOTS_H, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  empty: { alignItems: 'center', justifyContent: 'center' },
  bar: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, paddingRight: 8 },
  tabs: { paddingHorizontal: 8, alignItems: 'center', gap: 4 },
  tab: { width: 44, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  send: { height: 34, paddingHorizontal: 16, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
});
